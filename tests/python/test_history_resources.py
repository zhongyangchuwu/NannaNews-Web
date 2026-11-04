import gzip
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import zipfile

import pytest


SCRIPT = Path(__file__).parents[2] / 'scripts' / 'stage-history.py'
VERSION = 'a' * 64
COUNTS = {'documents': 1, 'images': 1, 'issues': 1, 'items': 1, 'occurrences': 1, 'pdfs': 0}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def fixture(tmp_path, mutate=None, extra=None):
    bootstrap = encoded({'schema_version': 3, 'generator': 'nannanews-reader-v3',
                         'data_version': VERSION, 'counts': COUNTS})
    raw = encoded({'items': [{'id': 'historic-item', 'body': 'original text'}]})
    image = b'synthetic image'
    base = f'versions/{VERSION}'
    contents = {'manifest.json': bootstrap,
                f'{base}/reader-v3/issues.json.gz': gzip.compress(raw, mtime=0),
                f'{base}/assets/{digest(image)}.jpg': image}
    descriptors = []
    for path, data in contents.items():
        compressed = path.endswith('.gz')
        source = raw if compressed else data
        descriptors.append({'path': path, 'source_path': path[:-3] if compressed else path,
                            'encoding': 'gzip' if compressed else 'identity', 'size': len(data),
                            'sha256': digest(data), 'source_size': len(source), 'source_sha256': digest(source)})
    manifest = {'schema_version': 1, 'generator': 'nannanews-history-resources-v1',
                'data_version': VERSION, 'source_manifest_sha256': digest(bootstrap),
                'counts': COUNTS, 'files': descriptors}
    if mutate:
        mutate(manifest, contents)
    archive = tmp_path / 'bundle.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr('resource-manifest.json', encoded(manifest))
        for path, data in contents.items():
            bundle.writestr(path, data)
        if extra:
            extra(bundle)
    data = archive.read_bytes()
    config = {'schema_version': 1, 'generator': 'nannanews-history-source-v1',
              'repository': 'owner/repo', 'data_version': VERSION, 'counts': COUNTS,
              'archive': {'url': 'https://github.com/owner/repo/releases/download/v1/bundle.zip',
                          'size': len(data), 'sha256': digest(data)}}
    config_path = tmp_path / 'history.json'
    config_path.write_bytes(encoded(config))
    return config_path, archive, contents, raw


def run(tmp_path, config, archive, output=None):
    return subprocess.run([sys.executable, str(SCRIPT), '--config', str(config), '--archive', str(archive),
                           '--cache', str(tmp_path / 'cache'), '--output', str(output or tmp_path / 'output')],
                          capture_output=True, text=True)


def test_stages_complete_original_consumer_bytes_and_replaces_owned_output(tmp_path):
    config, archive, contents, raw = fixture(tmp_path)
    output = tmp_path / 'output'
    first = run(tmp_path, config, archive)
    assert first.returncode == 0, first.stderr
    assert {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()} == set(contents) | {'resource-manifest.json'}
    for name, data in contents.items():
        assert (output / name).read_bytes() == data
    compressed = next(name for name in contents if name.endswith('.gz'))
    assert gzip.decompress((output / compressed).read_bytes()) == raw
    second = run(tmp_path, config, archive)
    assert second.returncode == 0, second.stderr
    assert (output / compressed).read_bytes() == contents[compressed]
    assert not (tmp_path / 'cache').exists()


def bad_hash(manifest, contents):
    manifest['files'][1]['sha256'] = '0' * 64


def bad_source_hash(manifest, contents):
    manifest['files'][1]['source_sha256'] = '0' * 64


def bad_source_size(manifest, contents):
    manifest['files'][1]['source_size'] -= 1


def bad_gzip(manifest, contents):
    item = manifest['files'][1]
    data = contents[item['path']][:-4]
    contents[item['path']] = data
    item['size'] = len(data)
    item['sha256'] = digest(data)


def bad_version(manifest, contents):
    manifest['data_version'] = 'b' * 64


def bad_counts(manifest, contents):
    manifest['counts'] = dict(COUNTS, items=2)


def bad_bootstrap(manifest, contents):
    bootstrap = encoded({'schema_version': 3, 'generator': 'nannanews-reader-v3',
                         'data_version': VERSION, 'counts': dict(COUNTS, issues=2)})
    contents['manifest.json'] = bootstrap
    item = manifest['files'][0]
    item['size'] = item['source_size'] = len(bootstrap)
    item['sha256'] = item['source_sha256'] = digest(bootstrap)
    manifest['source_manifest_sha256'] = digest(bootstrap)


def bad_path(manifest, contents):
    item = manifest['files'][1]
    item['source_path'] = '../secret.json'
    item['path'] = '../secret.json.gz'


def active_content(manifest, contents):
    item = manifest['files'][1]
    item['source_path'] = f'versions/{VERSION}/reader-v3/page.html'
    item['path'] = item['source_path']
    item['encoding'] = 'identity'


def unregistered(bundle):
    bundle.writestr('unregistered.html', '<script>evil()</script>')


def duplicate(bundle):
    bundle.writestr('manifest.json', b'duplicate')


def symlink(bundle):
    info = zipfile.ZipInfo('link')
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    bundle.writestr(info, 'manifest.json')


@pytest.mark.parametrize('mutation,extra', [
    (bad_hash, None), (bad_source_hash, None), (bad_source_size, None), (bad_gzip, None),
    (bad_version, None), (bad_counts, None), (bad_bootstrap, None), (bad_path, None), (active_content, None),
    (None, unregistered), (None, duplicate), (None, symlink),
])
def test_rejects_corrupt_or_unsafe_bundle_without_replacing_existing_output(tmp_path, mutation, extra):
    config, archive, _, _ = fixture(tmp_path)
    assert run(tmp_path, config, archive).returncode == 0
    output = tmp_path / 'output'
    before = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()}
    config, archive, _, _ = fixture(tmp_path, mutation, extra)
    result = run(tmp_path, config, archive)
    assert result.returncode != 0
    assert 'history staging failed:' in result.stderr
    assert {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()} == before
    assert not list(tmp_path.glob('.history-stage-*'))


def test_archive_hash_and_unowned_output_are_protected(tmp_path):
    config, archive, _, _ = fixture(tmp_path)
    output = tmp_path / 'output'
    output.mkdir()
    (output / 'important.txt').write_text('keep')
    assert run(tmp_path, config, archive).returncode != 0
    assert (output / 'important.txt').read_text() == 'keep'
    archive.write_bytes(archive.read_bytes() + b'changed')
    result = run(tmp_path, config, archive, tmp_path / 'other')
    assert result.returncode != 0
    assert 'archive' in result.stderr
    assert not (tmp_path / 'other').exists()


def test_failed_promotion_restores_previous_output(tmp_path, monkeypatch):
    config, archive, _, _ = fixture(tmp_path)
    output = tmp_path / 'output'
    assert run(tmp_path, config, archive).returncode == 0
    before = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()}
    spec = importlib.util.spec_from_file_location('history_stager', SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rename = os.rename

    def fail_promotion(source, destination):
        if Path(source).name == 'resources':
            raise OSError('simulated promotion failure')
        return rename(source, destination)

    monkeypatch.setattr(module.os, 'rename', fail_promotion)
    with pytest.raises(OSError, match='simulated promotion failure'):
        module.stage_history(config, output, tmp_path / 'cache', archive)
    assert {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()} == before
    assert not list(tmp_path.glob('.history-stage-*'))
    assert not (tmp_path / '.output.history-stage-lock').exists()


@pytest.mark.parametrize('foreign', ['file', 'directory'])
def test_owned_marker_does_not_authorize_deleting_unregistered_data(tmp_path, foreign):
    config, archive, contents, _ = fixture(tmp_path)
    assert run(tmp_path, config, archive).returncode == 0
    output = tmp_path / 'output'
    unrelated = output / 'operator-notes'
    if foreign == 'file':
        unrelated.write_bytes(b'preserve unrelated content')
    else:
        unrelated.mkdir()
    result = run(tmp_path, config, archive)
    assert result.returncode != 0
    assert unrelated.is_dir() if foreign == 'directory' else unrelated.read_bytes() == b'preserve unrelated content'
    assert (output / 'manifest.json').read_bytes() == contents['manifest.json']


def test_cache_is_verified_before_reuse(tmp_path):
    config, archive, _, _ = fixture(tmp_path)
    metadata = json.loads(config.read_bytes())['archive']
    cache = tmp_path / 'cache'
    cache.mkdir()
    cached = cache / (metadata['sha256'] + '.zip')
    cached.write_bytes(archive.read_bytes())
    command = [sys.executable, str(SCRIPT), '--config', str(config), '--cache', str(cache),
               '--output', str(tmp_path / 'cached-output')]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    cached.write_bytes(b'corrupt')
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode != 0
    assert 'archive' in result.stderr
    assert (tmp_path / 'cached-output' / 'manifest.json').is_file()


def test_help_and_import_have_no_filesystem_side_effects(tmp_path):
    help_result = subprocess.run([sys.executable, str(SCRIPT), '--help'], cwd=tmp_path, capture_output=True, text=True)
    assert help_result.returncode == 0
    imported = subprocess.run([sys.executable, '-c',
                               'import runpy, sys; runpy.run_path(sys.argv[1], run_name="history_module")', str(SCRIPT)],
                              cwd=tmp_path, capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    assert imported.returncode == 0
    assert list(tmp_path.iterdir()) == []
