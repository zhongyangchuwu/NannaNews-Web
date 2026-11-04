#!/usr/bin/env python3
"""Download, validate and stage a pinned public history resource archive."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
import zlib

MAX_TOTAL = 1_000_000_000
MAX_FILE = 256_000_000
MAX_JSON = 128_000_000
MAX_MANIFEST = 16_000_000
CHUNK = 1024 * 1024
HASH = re.compile(r'[0-9a-f]{64}\Z')
COUNTS = {'documents', 'images', 'issues', 'items', 'occurrences', 'pdfs'}


class StageError(Exception):
    pass


class RollbackError(StageError):
    pass


def require(condition, message):
    if not condition:
        raise StageError(message)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f'duplicate JSON key: {key}')
        result[key] = value
    return result


def parse_json(data):
    try:
        return json.loads(data, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError) as exc:
        raise StageError(f'invalid JSON: {exc}') from exc


def valid_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def size_value(value, maximum):
    return type(value) is int and 0 <= value <= maximum


def valid_counts(counts):
    return (isinstance(counts, dict) and set(counts) == COUNTS
            and all(size_value(v, MAX_TOTAL) for v in counts.values()))


def load_config(path):
    with path.open('rb') as stream:
        data = stream.read(MAX_MANIFEST + 1)
    require(len(data) <= MAX_MANIFEST, 'configuration too large')
    config = parse_json(data)
    require(isinstance(config, dict) and set(config) == {
        'schema_version', 'generator', 'repository', 'data_version', 'counts', 'archive'
    }, 'invalid source configuration fields')
    require(type(config['schema_version']) is int and config['schema_version'] == 1
            and config['generator'] == 'nannanews-history-source-v1', 'invalid source configuration version')
    repo = config['repository']
    require(isinstance(repo, str) and re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo)
            and all(part not in ('.', '..') for part in repo.split('/')), 'invalid repository')
    require(valid_hash(config['data_version']) and valid_counts(config['counts']), 'invalid version or counts')
    archive = config['archive']
    require(isinstance(archive, dict) and set(archive) == {'url', 'size', 'sha256'}
            and size_value(archive['size'], MAX_TOTAL) and archive['size'] > 0
            and valid_hash(archive['sha256']), 'invalid archive configuration')
    url = archive['url']
    require(isinstance(url, str), 'invalid archive URL')
    parsed = urllib.parse.urlsplit(url)
    prefix = '/' + repo + '/releases/download/'
    require(parsed.scheme == 'https' and parsed.netloc == 'github.com'
            and parsed.path.startswith(prefix) and re.fullmatch(r'[^/]+/[^/]+\.zip', parsed.path[len(prefix):])
            and not parsed.query and not parsed.fragment and '%' not in parsed.path, 'invalid archive URL')
    return config


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlsplit(newurl)
        require(url.scheme == 'https' and url.netloc in {
            'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'
        }, 'unsafe archive redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def verify_archive(path, archive):
    digest = hashlib.sha256()
    total = 0
    with path.open('rb') as stream:
        while block := stream.read(CHUNK):
            total += len(block)
            require(total <= archive['size'], 'archive size mismatch')
            digest.update(block)
    require(total == archive['size'] and digest.hexdigest() == archive['sha256'], 'archive size or SHA-256 mismatch')


def acquire(config, cache, local_archive):
    archive = config['archive']
    if local_archive is not None:
        verify_archive(local_archive, archive)
        return local_archive
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / (archive['sha256'] + '.zip')
    if target.exists():
        verify_archive(target, archive)
        return target
    fd, name = tempfile.mkstemp(prefix='.history-download-', dir=cache)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'wb') as out:
            opener = urllib.request.build_opener(ReleaseRedirect())
            request = urllib.request.Request(archive['url'], headers={'User-Agent': 'NannaNews-history-stager'})
            with opener.open(request, timeout=60) as response:
                total = 0
                digest = hashlib.sha256()
                while block := response.read(CHUNK):
                    total += len(block)
                    require(total <= archive['size'], 'download exceeds declared size')
                    digest.update(block)
                    out.write(block)
                require(total == archive['size'] and digest.hexdigest() == archive['sha256'],
                        'download size or SHA-256 mismatch')
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return target


def safe_path(value):
    require(isinstance(value, str) and value and len(value) <= 1024
            and '\\' not in value and all(ord(c) >= 32 and ord(c) != 127 for c in value), 'unsafe path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(part not in ('', '.', '..') for part in value.split('/'))
            and str(path) == value, f'unsafe path: {value}')
    return value


def descriptor(item, version):
    fields = {'path', 'source_path', 'encoding', 'size', 'sha256', 'source_size', 'source_sha256'}
    require(isinstance(item, dict) and set(item) == fields, 'invalid resource descriptor')
    path = safe_path(item['path'])
    source = safe_path(item['source_path'])
    prefix = f'versions/{version}/'
    if source == 'manifest.json':
        require(path == source and item['encoding'] == 'identity', 'invalid bootstrap mapping')
    elif source.startswith(prefix + 'reader-v3/') and source.endswith('.json'):
        require(path == source + '.gz' and item['encoding'] == 'gzip', 'invalid JSON mapping')
    elif source.startswith(prefix + 'assets/') and re.fullmatch(r'[0-9a-f]{64}\.(?:jpg|png|pdf)', source[len(prefix + 'assets/'):]):
        require(path == source and item['encoding'] == 'identity', 'invalid asset mapping')
    else:
        raise StageError(f'disallowed resource type or path: {source}')
    limit = MAX_JSON if source.endswith('.json') else MAX_FILE
    require(size_value(item['size'], MAX_FILE) and size_value(item['source_size'], limit)
            and valid_hash(item['sha256']) and valid_hash(item['source_sha256']), 'invalid resource size or hash')
    if item['encoding'] == 'identity':
        require(item['size'] == item['source_size'] and item['sha256'] == item['source_sha256'], 'invalid identity descriptor')
    return path


def validate_header(manifest, config, schema, generator):
    require(isinstance(manifest, dict) and type(manifest.get('schema_version')) is int
            and manifest.get('schema_version') == schema and manifest.get('generator') == generator
            and manifest.get('data_version') == config['data_version']
            and manifest.get('counts') == config['counts'] and valid_counts(manifest.get('counts')),
            'manifest version or counts mismatch')


def member_info(info):
    safe_path(info.filename)
    mode = info.external_attr >> 16
    require(not info.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG), 'nonregular ZIP member')
    require(info.compress_type == zipfile.ZIP_STORED and not (info.flag_bits & 1), 'unsupported ZIP member encoding')
    require(info.file_size <= MAX_FILE and info.compress_size == info.file_size, 'ZIP member too large')


def check_source(path, item):
    digest = hashlib.sha256()
    total = 0
    with gzip.open(path, 'rb') as stream:
        while block := stream.read(CHUNK):
            total += len(block)
            require(total <= item['source_size'], 'gzip source exceeds declared size')
            digest.update(block)
    require(total == item['source_size'] and digest.hexdigest() == item['source_sha256'], 'gzip source size or SHA-256 mismatch')


def extract(archive, stage, config):
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        require(len(infos) <= 100_000, 'too many ZIP members')
        members = {}
        for info in infos:
            member_info(info)
            require(info.filename not in members, 'duplicate ZIP member')
            members[info.filename] = info
        require('resource-manifest.json' in members and members['resource-manifest.json'].file_size <= MAX_MANIFEST,
                'missing or oversized resource manifest')
        raw = bundle.read(members['resource-manifest.json'])
        manifest = parse_json(raw)
        validate_header(manifest, config, 1, 'nannanews-history-resources-v1')
        require(valid_hash(manifest.get('source_manifest_sha256')) and isinstance(manifest.get('files'), list), 'invalid resource manifest')
        files = {}
        total = len(raw)
        for item in manifest['files']:
            path = descriptor(item, config['data_version'])
            require(path not in files and path != 'resource-manifest.json', 'duplicate resource descriptor')
            files[path] = item
            total += item['size']
            require(total <= MAX_TOTAL, 'staged size exceeds budget')
        require('manifest.json' in files and set(members) == set(files) | {'resource-manifest.json'}, 'ZIP members do not match allowlist')
        require(files['manifest.json']['sha256'] == manifest['source_manifest_sha256'], 'bootstrap manifest hash mismatch')
        (stage / 'resource-manifest.json').write_bytes(raw)
        for name, item in files.items():
            info = members[name]
            require(info.file_size == item['size'], f'resource size mismatch: {name}')
            dest = stage / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            count = 0
            with bundle.open(info) as source, dest.open('xb') as out:
                while block := source.read(CHUNK):
                    count += len(block)
                    require(count <= item['size'], f'resource exceeds declared size: {name}')
                    digest.update(block)
                    out.write(block)
            require(count == item['size'] and digest.hexdigest() == item['sha256'], f'resource SHA-256 mismatch: {name}')
            if item['encoding'] == 'gzip':
                check_source(dest, item)
        bootstrap = parse_json((stage / 'manifest.json').read_bytes())
        validate_header(bootstrap, config, 3, 'nannanews-reader-v3')


def owned(output):
    require(output.is_dir() and not output.is_symlink(), 'existing output is not an owned directory')
    marker = output / 'resource-manifest.json'
    require(marker.is_file() and not marker.is_symlink() and marker.stat().st_size <= MAX_MANIFEST, 'existing output has no owned resource manifest')
    data = parse_json(marker.read_bytes())
    require(isinstance(data, dict) and type(data.get('schema_version')) is int
            and data.get('schema_version') == 1 and data.get('generator') == 'nannanews-history-resources-v1'
            and valid_hash(data.get('data_version')) and valid_hash(data.get('source_manifest_sha256'))
            and valid_counts(data.get('counts')) and isinstance(data.get('files'), list), 'existing output has no owned resource manifest')
    expected = {'resource-manifest.json'}
    directories = set()
    for item in data['files']:
        name = descriptor(item, data['data_version'])
        require(name not in expected, 'existing output has duplicate resource paths')
        expected.add(name)
        directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != '.')
    observed = set()
    for entry in output.rglob('*'):
        name = entry.relative_to(output).as_posix()
        require(not entry.is_symlink(), 'existing output contains a symlink')
        if entry.is_dir():
            require(name in directories, f'existing output contains an unowned directory: {name}')
        else:
            require(entry.is_file(), 'existing output contains a nonregular entry')
            observed.add(name)
    require(observed == expected, 'existing output contains missing or unowned resources')

def promote(stage, output):
    backup = stage.parent / 'previous'
    exists = os.path.lexists(output)
    if exists:
        owned(output)
        os.rename(output, backup)
    try:
        os.rename(stage, output)
    except OSError as error:
        if exists:
            try:
                os.rename(backup, output)
            except OSError as rollback_error:
                raise RollbackError(f'promotion failed ({error}); previous output retained at {backup}: {rollback_error}') from rollback_error
        raise


def stage_history(config_path, output, cache, local_archive):
    config = load_config(config_path)
    archive = acquire(config, cache, local_archive)
    output = output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    lock = output.parent / f'.{output.name}.history-stage-lock'
    try:
        lock.mkdir()
    except FileExistsError as exc:
        raise StageError(f'another staging operation holds {lock}') from exc
    try:
        if os.path.lexists(output):
            owned(output)
        temp = Path(tempfile.mkdtemp(prefix='.history-stage-', dir=output.parent))
        preserve = False
        try:
            stage = temp / 'resources'
            stage.mkdir()
            extract(archive, stage, config)
            promote(stage, output)
        except RollbackError:
            preserve = True
            raise
        finally:
            if not preserve:
                shutil.rmtree(temp)
    finally:
        lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('data/history.json'))
    parser.add_argument('--output', type=Path, default=Path('.generated/site/history-data'))
    parser.add_argument('--cache', type=Path, default=Path('.cache/history'))
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    try:
        stage_history(args.config, args.output, args.cache, args.archive)
    except (StageError, OSError, ValueError, EOFError, zlib.error, zipfile.BadZipFile) as exc:
        print(f'history staging failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
