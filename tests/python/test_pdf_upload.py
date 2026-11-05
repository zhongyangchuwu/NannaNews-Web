import hashlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nannaweb.catalog import _validate_catalog, import_pdfs


spec = importlib.util.spec_from_file_location('pdf_upload', Path(__file__).parents[2] / 'scripts' / 'pdf-upload.py')
assert spec is not None and spec.loader is not None
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)

BASE, HEAD, NEXT = 'a' * 40, 'b' * 40, 'c' * 40
MERGED = 'e' * 40
PDF = b'synthetic pdf data'
PDF_SHA = hashlib.sha1(b'blob ' + str(len(PDF)).encode() + b'\0' + PDF).hexdigest()


class FakeGitHub(upload.GitHub):
    repository = 'owner/project'
    root = '/repos/owner/project'

    def __init__(self):
        repo = {'id': 1, 'full_name': self.repository, 'default_branch': 'main', 'private': False}
        self.pr = {'state': 'open', 'draft': False, 'user': {'login': 'author', 'type': 'User'},
                   'base': {'ref': 'main', 'sha': BASE, 'repo': repo},
                   'head': {'ref': 'upload', 'sha': HEAD, 'repo': dict(repo)}, 'changed_files': 1}
        self.changed = [{'filename': 'pdf/new.pdf', 'status': 'added'}]
        self.permissions = {'author': 'write', 'actor': 'write', 'rerunner': 'write'}
        self.catalog_sha = 'd' * 40
        self.head_catalog_sha = self.catalog_sha
        self.pdf_entry = {'mode': '100644', 'type': 'blob', 'sha': PDF_SHA}
        self.checks = []
        self.commits = []
        self.comparison = {'status': 'ahead', 'behind_by': 0}
        self.base_extras = {}
        self.head_extras = {}
        self.merges = []
        self.publications = []
        self.reject_merge = False
        self.merge_head = None
        self.fail_dispatch = False

    def get(self, path):
        if path == '/pulls/7':
            return self.pr
        if path.startswith('/compare/'):
            return self.comparison
        if path.startswith('/collaborators/') and path.endswith('/permission'):
            login = path.split('/')[2]
            return {'permission': self.permissions.get(login, 'none'), 'user': {'login': login}}
        if path.startswith('/pulls/7/files?'):
            return self.changed if 'page=1' in path else []
        raise AssertionError(path)

    def tree(self, sha):
        tree = {'data/catalog.json': {'mode': '100644', 'sha': self.catalog_sha}}
        tree.update(self.head_extras if sha == HEAD else self.base_extras)
        if sha == HEAD:
            tree['data/catalog.json']['sha'] = self.head_catalog_sha
            tree['pdf/new.pdf'] = self.pdf_entry
        return tree

    def blob(self, sha):
        assert sha == PDF_SHA
        return PDF

    def request(self, path, body=None, *, method=None):
        if path == '/graphql':
            fields = body['variables']['input']
            if fields['expectedHeadOid'] != self.pr['head']['sha']:
                return {'errors': [{'message': 'stale head'}]}
            assert fields['branch'] == {'repositoryNameWithOwner': self.repository, 'branchName': 'upload'}
            assert [item['path'] for item in fields['fileChanges']['additions']] == ['data/catalog.json']
            self.commits.append(fields)
            self.pr['head']['sha'] = NEXT
            return {'data': {'createCommitOnBranch': {'commit': {'oid': NEXT}}}}
        if path == self.root + '/pulls/7/merge':
            assert method == 'PUT' and body['merge_method'] == 'merge'
            if self.merge_head:
                self.pr['head']['sha'] = self.merge_head
            if self.reject_merge or body['sha'] != self.pr['head']['sha']:
                return {'merged': False}
            self.merges.append(self.pr['head']['sha'])
            self.pr.update(state='closed', merged=True)
            self.pr['base']['sha'] = MERGED
            return {'merged': True, 'sha': MERGED}
        if path == self.root + '/actions/workflows/site.yml/dispatches':
            if self.fail_dispatch:
                raise OSError('Publication dispatch failed.')
            self.publications.append((body['ref'], self.pr['base']['sha']))
            return None
        assert path == self.root + '/check-runs'
        self.checks.append(body)
        return {'id': 1}


def gate(api, actor='actor', rerunner='rerunner', expected_head=HEAD):
    return upload.eligible(api, 7, 'main', BASE, actor, rerunner, expected_head)


def test_accepts_only_same_repo_authorized_batch():
    api = FakeGitHub()
    result = gate(api)
    assert result['head_sha'] == HEAD
    assert result['pdfs'] == {'pdf/new.pdf': PDF_SHA}
    for person in ('author', 'actor', 'rerunner'):
        api = FakeGitHub()
        api.permissions[person] = 'read'
        with pytest.raises(upload.UploadError):
            gate(api)
    api = FakeGitHub()
    api.pr['head']['repo']['id'] = 2
    with pytest.raises(upload.UploadError):
        gate(api)
    api.pr['head']['repo'] = None
    with pytest.raises(upload.UploadError):
        gate(api)

@pytest.mark.parametrize('base_paths,head_paths', [
    ({'pdf/old.pdf': 'e' * 40}, {}),
    ({'src/App.tsx': 'e' * 40}, {'src/App.tsx': 'f' * 40}),
    ({}, {'scripts/injected.py': 'e' * 40}),
])
def test_immutable_tree_diff_rejects_equal_count_pr_file_mismatch(base_paths, head_paths):
    api = FakeGitHub()
    api.base_extras = {name: {'type': 'blob', 'mode': '100644', 'sha': sha} for name, sha in base_paths.items()}
    api.head_extras = {name: {'type': 'blob', 'mode': '100644', 'sha': sha} for name, sha in head_paths.items()}
    with pytest.raises(upload.UploadError):
        gate(api)



@pytest.mark.parametrize('filename,status', [
    ('scripts/run.sh', 'added'), ('pdf/old.pdf', 'modified'), ('pdf/sub/new.pdf', 'added'),
    ('pdf/new.pdf\nother', 'added'), ('data/catalog.json', 'modified'),
])
def test_unexpected_files_and_batch_changes_fail_closed(filename, status):
    api = FakeGitHub()
    api.changed = [{'filename': filename, 'status': status}]
    with pytest.raises(upload.UploadError):
        gate(api)


def test_stale_events_nonregular_blobs_and_diverged_base_are_rejected():
    api = FakeGitHub()
    with pytest.raises(upload.UploadError):
        gate(api, expected_head=NEXT)
    api.pdf_entry['mode'] = '120000'
    with pytest.raises(upload.UploadError):
        gate(api)
    api = FakeGitHub()
    api.comparison = {'status': 'diverged', 'behind_by': 1}
    with pytest.raises(upload.UploadError):
        gate(api)
    api = FakeGitHub()
    api.head_catalog_sha = 'e' * 40
    with pytest.raises(upload.UploadError):
        gate(api)
    with pytest.raises(upload.UploadError):
        gate(FakeGitHub(), actor='actor\nmalicious')
    api = FakeGitHub()
    api.pr['base']['repo']['private'] = True
    with pytest.raises(upload.UploadError):
        gate(api)


def test_catalog_is_committed_only_at_expected_head_and_check_targets_new_sha(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path('data').mkdir()
    Path('data/catalog.json').write_text('{}', encoding='utf-8')
    api = FakeGitHub()
    manifest = gate(api)
    catalog = tmp_path / 'catalog.json'
    catalog.write_text('{"schema_version": 3}', encoding='utf-8')
    assert upload.publish(api, manifest, catalog) == NEXT
    assert api.checks[0]['head_sha'] == NEXT
    assert api.checks[0]['conclusion'] == 'success'
    assert api.commits[0]['expectedHeadOid'] == HEAD
    api = FakeGitHub()
    api.pr['head']['sha'] = NEXT
    with pytest.raises(upload.UploadError):
        upload.publish(api, manifest, catalog)
    assert api.checks == []


def test_duplicate_candidate_checks_original_head_without_empty_commit(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path('data').mkdir()
    Path('data/catalog.json').write_text('{}', encoding='utf-8')
    catalog = tmp_path / 'duplicate.json'
    catalog.write_text('{}', encoding='utf-8')
    api = FakeGitHub()
    assert upload.publish(api, gate(api), catalog) == HEAD
    assert api.commits == []
    assert api.checks[0]['head_sha'] == HEAD


def document(data, number):
    return {'schema_version': 1, 'issue_date': '2026-12-31', 'issue_number': number,
            'title': 'Synthetic', 'source_sha256': hashlib.sha256(data).hexdigest(),
            'items': [{'local_key': 'a', 'kind': 'detail', 'title': f'Synthetic activity {number}',
                       'category': '', 'body_text': 'Synthetic text', 'body_lines': [],
                       'primary_urls': [], 'other_urls': [], 'locator': {'page': 1}, 'dates': []}],
            'warnings': [], 'parser': {'version': '2.14.4', 'text_layer': 'poppler-xml-1'}}


@pytest.fixture
def candidate_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path('pdf').mkdir()
    Path('pdf/old.pdf').write_bytes(PDF)
    base = tmp_path / 'base.json'
    candidate = tmp_path / 'candidate.json'
    parse = lambda path, _: document(Path(path).read_bytes(), 1 if Path(path).name == 'old.pdf' else 2)
    with patch('nannaweb.catalog.parse_pdf', side_effect=parse):
        import_pdfs('pdf', base, 'cache')
        accepted = json.loads(base.read_bytes())
        accepted['identity_aliases'] = [{'legacy_id': 'historical', 'activity_id': accepted['activities'][0]['id']}]
        base.write_text(json.dumps(accepted), encoding='utf-8')
        candidate.write_bytes(base.read_bytes())
        new_bytes = b'new synthetic PDF'
        Path('pdf/new.pdf').write_bytes(new_bytes)
        import_pdfs('pdf', candidate, 'cache')
    blob = hashlib.sha1(b'blob ' + str(len(new_bytes)).encode() + b'\0' + new_bytes).hexdigest()
    return base, candidate, {'pdfs': {'pdf/new.pdf': blob}}


def test_incremental_candidate_accepts_only_new_sources_and_duplicate_noop(candidate_files):
    base, candidate, manifest = candidate_files
    accepted = base.read_bytes()
    assert upload.validate_candidate(base, candidate, manifest) == 1
    assert base.read_bytes() == accepted
    candidate.write_bytes(accepted)
    Path('pdf/copy.pdf').write_bytes(PDF)
    assert upload.validate_candidate(base, candidate, {'pdfs': {'pdf/copy.pdf': PDF_SHA}}) == 0


@pytest.mark.parametrize('change', ['source', 'publication', 'remove', 'unauthorized', 'old_issue_append', 'alias'])
def test_schema_valid_candidate_cannot_rewrite_history_or_invent_sources(candidate_files, change):
    base, candidate, manifest = candidate_files
    data = json.loads(candidate.read_bytes())
    if change == 'source':
        data['details'][0]['text'] = 'Altered accepted original.'
    elif change == 'publication':
        first, second = data['publications']
        first['activity_id'], second['activity_id'] = second['activity_id'], first['activity_id']
    elif change == 'remove':
        old_issue = data['issues'].pop(0)['id']
        data['details'] = [row for row in data['details'] if row['issue_id'] != old_issue]
        data['publications'] = [row for row in data['publications'] if row['issue_id'] != old_issue]
        remaining = {row['activity_id'] for row in data['publications']}
        data['activities'] = [row for row in data['activities'] if row['id'] in remaining]
        data['identity_aliases'] = []
    elif change == 'unauthorized':
        Path('unapproved').mkdir()
        Path('unapproved/extra.pdf').write_bytes(b'unauthorized synthetic PDF')
        with patch('nannaweb.catalog.parse_pdf', side_effect=lambda path, _: document(Path(path).read_bytes(), 3)):
            import_pdfs('unapproved', candidate, 'cache')
        data = json.loads(candidate.read_bytes())
    elif change == 'old_issue_append':
        extra = dict(data['details'][0], id='extra-old-source', order=99)
        data['details'].append(extra)
        data['activities'].append({'id': 'extra-old-activity'})
        data['publications'].append({'activity_id': 'extra-old-activity', 'issue_id': extra['issue_id'],
                                     'listing_ids': [], 'detail_id': extra['id']})
    else:
        data['identity_aliases'][0]['activity_id'] = data['activities'][1]['id']
    _validate_catalog(data)
    candidate.write_text(json.dumps(data), encoding='utf-8')
    with pytest.raises(upload.UploadError):
        upload.validate_candidate(base, candidate, manifest)


@pytest.fixture
def validated_upload(candidate_files):
    base, candidate, sources = candidate_files
    Path('data').mkdir()
    Path('data/catalog.json').write_bytes(base.read_bytes())
    api = FakeGitHub()
    api.pdf_entry['sha'] = sources['pdfs']['pdf/new.pdf']
    manifest = gate(api)
    assert upload.validate_candidate(base, candidate, manifest) == 1
    head = upload.publish(api, manifest, candidate)
    return api, manifest, head


def test_validated_default_branch_upload_is_merged_and_publication_is_queued(validated_upload):
    api, manifest, head = validated_upload
    assert upload.auto_publish(api, manifest, head) == MERGED
    assert api.pr['state'] == 'closed' and api.pr['merged'] is True
    assert api.merges == [NEXT]
    assert api.publications == [('main', MERGED)]


@pytest.mark.parametrize('change', ['head', 'base', 'closed', 'draft', 'fork', 'private'])
def test_changed_upload_cannot_merge_or_publish(validated_upload, change):
    api, manifest, head = validated_upload
    if change == 'head':
        api.pr['head']['sha'] = HEAD
    elif change == 'base':
        api.pr['base']['sha'] = MERGED
    elif change == 'closed':
        api.pr['state'] = 'closed'
    elif change == 'draft':
        api.pr['draft'] = True
    elif change == 'fork':
        api.pr['head']['repo']['id'] = 2
    else:
        api.pr['base']['repo']['private'] = True
    with pytest.raises(upload.UploadError):
        upload.auto_publish(api, manifest, head)
    assert api.merges == [] and api.publications == []


def test_nondefault_branch_validation_never_merges_or_deploys(validated_upload):
    api, manifest, head = validated_upload
    api.pr['base']['ref'] = manifest['base_ref'] = 'implementation'
    assert upload.auto_publish(api, manifest, head) is None
    assert api.pr['state'] == 'open'
    assert api.merges == [] and api.publications == []


@pytest.mark.parametrize('rejection', ['late_head', 'branch_rule'])
def test_rejected_merge_never_dispatches_publication(validated_upload, rejection):
    api, manifest, head = validated_upload
    if rejection == 'late_head':
        api.merge_head = HEAD
    else:
        api.reject_merge = True
    with pytest.raises(upload.UploadError):
        upload.auto_publish(api, manifest, head)
    assert api.pr['state'] == 'open'
    assert api.merges == [] and api.publications == []


def test_dispatch_failure_is_reported_instead_of_claiming_publication(validated_upload):
    api, manifest, head = validated_upload
    api.fail_dispatch = True
    with pytest.raises(OSError, match='Publication dispatch failed'):
        upload.auto_publish(api, manifest, head)
    assert api.pr['state'] == 'closed' and api.pr['merged'] is True
    assert api.publications == []
