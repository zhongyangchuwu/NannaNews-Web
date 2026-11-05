"""Validate a public PDF batch, then merge and publish its exact accepted head."""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


class UploadError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise UploadError(message)


class GitHub:
    def __init__(self, token, repository):
        require(bool(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)), 'Invalid repository.')
        self.token, self.repository = token, repository
        self.root = '/repos/' + repository

    def request(self, path, body=None, *, method=None):
        data = json.dumps(body).encode() if body is not None else None
        request = Request('https://api.github.com' + path, data=data, headers={
            'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + self.token,
            'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
        }, method=method)
        with urlopen(request, timeout=30) as response:
            if response.status == 204:
                return None
            return json.load(response)

    def get(self, path):
        return self.request(self.root + path)

    def permission(self, login):
        require(isinstance(login, str) and bool(re.fullmatch(r'[A-Za-z0-9-]+', login)), 'Invalid actor.')
        result = self.get('/collaborators/' + quote(login, safe='') + '/permission')
        require(result.get('user', {}).get('login', '').lower() == login.lower(), 'Permission identity mismatch.')
        require(result.get('permission') in ('admin', 'write'), 'PR author and triggering actors must have write access.')

    def files(self, number, expected):
        files = []
        for page in range(1, 32):
            batch = self.get(f'/pulls/{number}/files?per_page=100&page={page}')
            require(isinstance(batch, list), 'Invalid changed-file response.')
            files.extend(batch)
            if len(batch) < 100:
                break
        require(len(files) == expected and expected <= 3000, 'Incomplete changed-file list.')
        return files

    def tree(self, sha):
        data = self.get('/git/trees/' + sha + '?recursive=1')
        require(data.get('truncated') is False and isinstance(data.get('tree'), list), 'Incomplete Git tree.')
        return {entry['path']: entry for entry in data['tree']}

    def blob(self, sha):
        data = self.get('/git/blobs/' + sha)
        require(data.get('encoding') == 'base64', 'Unsupported blob encoding.')
        raw = base64.b64decode(data['content'], validate=False)
        require(data.get('size') == len(raw), 'Blob size mismatch.')
        actual = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        require(actual == sha, 'Blob hash mismatch.')
        return raw


def eligible(api, number, base_ref, base_sha, actor, triggering_actor, expected_head=''):
    require(isinstance(number, int) and number > 0, 'Invalid PR number.')
    pr = api.get('/pulls/' + str(number))
    require(pr.get('state') == 'open' and not pr.get('draft'), 'PR must be open and ready for review.')
    base, head = pr['base'], pr['head']
    require(base['repo']['full_name'].lower() == api.repository.lower(), 'Unexpected base repository.')
    require(base['repo'].get('private') is False, 'Only public repository inputs are eligible.')
    require(head.get('repo') and head['repo']['id'] == base['repo']['id'], 'Fork PRs are not eligible.')
    require(base['ref'] == base_ref and base['sha'] == base_sha, 'Base branch changed; retry against its current commit.')
    require(head['ref'] != base_ref and head['ref'] != base['repo']['default_branch'], 'Cannot update a base or default branch.')
    require(bool(re.fullmatch(r'[0-9a-f]{40}', head['sha'])), 'Invalid head SHA.')
    require(not expected_head or head['sha'] == expected_head, 'PR head changed since the triggering event.')
    comparison = api.get('/compare/' + base_sha + '...' + head['sha'])
    require(comparison.get('status') == 'ahead' and comparison.get('behind_by') == 0,
            'Update the upload branch to the current base before importing.')
    require(pr['user'].get('type') == 'User', 'PR author must be a human account.')
    for login in {pr['user']['login'], actor, triggering_actor}:
        api.permission(login)
    files = api.files(number, pr['changed_files'])
    names = []
    for item in files:
        name = item.get('filename', '')
        require(item.get('status') == 'added' and bool(re.fullmatch(r'pdf/[^/\\\x00-\x1f\x7f]+\.pdf', name, re.IGNORECASE)),
                'Only newly added PDF files are eligible. For another batch or a changed catalog, open a new upload PR.')
        names.append(name)
    require(bool(names) and len(names) == len(set(names)), 'No unique PDF batch was found.')
    base_tree, head_tree = api.tree(base_sha), api.tree(head['sha'])
    catalog = 'data/catalog.json'
    require(catalog in base_tree and catalog in head_tree and
            base_tree[catalog].get('mode') == head_tree[catalog].get('mode') == '100644' and
            base_tree[catalog].get('sha') == head_tree[catalog].get('sha'),
            'Catalog differs from the base. Open a new upload PR for another batch.')
    base_files = {name: entry for name, entry in base_tree.items() if entry.get('type') != 'tree'}
    head_files = {name: entry for name, entry in head_tree.items() if entry.get('type') != 'tree'}
    require(set(head_files) - set(base_files) == set(names), 'Immutable head has unexpected additions.')
    for name, entry in base_files.items():
        actual = head_files.get(name, {})
        require(all(actual.get(key) == entry.get(key) for key in ('mode', 'type', 'sha')),
                'Immutable head changes or removes an accepted file.')
    blobs = {}
    for name in names:
        entry = head_tree.get(name, {})
        require(entry.get('mode') == '100644' and entry.get('type') == 'blob' and
                bool(re.fullmatch(r'[0-9a-f]{40}', entry.get('sha', ''))), 'PDF must be a regular Git blob.')
        blobs[name] = entry['sha']
    return {'number': number, 'base_ref': base_ref, 'base_sha': base_sha,
            'head_ref': head['ref'], 'head_sha': head['sha'], 'author': pr['user']['login'],
            'actor': actor, 'triggering_actor': triggering_actor, 'pdfs': blobs}


def prepare(api, manifest):
    paths = []
    for name, sha in manifest['pdfs'].items():
        path = Path(name)
        require(not path.exists() and not path.is_symlink(), 'PDF path already exists in the trusted base.')
        path.write_bytes(api.blob(sha))
        paths.append(name)
    subprocess.run(['git', 'add', '--', *paths], check=True)


def validate_candidate(base_path, candidate_path, manifest):
    require(candidate_path.is_file() and not candidate_path.is_symlink(), 'Candidate catalog is missing.')
    base = json.loads(base_path.read_text(encoding='utf-8'))
    candidate = json.loads(candidate_path.read_text(encoding='utf-8'))
    require(isinstance(candidate, dict) and candidate.keys() == base.keys() and
            candidate.get('schema_version') == base['schema_version'], 'Candidate schema changed.')
    for name in ('issues', 'activities', 'listings', 'details', 'publications', 'identity_aliases', 'warnings'):
        rows = candidate.get(name)
        require(isinstance(rows, list) and rows[:len(base[name])] == base[name],
                'Candidate changes accepted ' + name + '.')
    require(candidate['identity_aliases'] == base['identity_aliases'], 'Upload cannot add identity aliases.')
    uploaded = {}
    for name in manifest['pdfs']:
        with Path(name).open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        uploaded.setdefault(digest, set()).add(Path(name).name)
    expected = set(uploaded) - {issue['sha256'] for issue in base['issues']}
    added = candidate['issues'][len(base['issues']):]
    require(len(added) == len(expected) and {issue['sha256'] for issue in added} == expected,
            'Candidate issues do not match the authorized PDF batch.')
    require(all(issue['filename'] in uploaded[issue['sha256']] for issue in added),
            'Candidate source filename does not match its PDF bytes.')
    added_ids = {issue['id'] for issue in added}
    for name in ('listings', 'details', 'publications'):
        require(all(row['issue_id'] in added_ids for row in candidate[name][len(base[name]):]),
                'Candidate adds ' + name + ' to an accepted issue.')
    added_names = {issue['filename'] for issue in added}
    require(all(row['filename'] in added_names for row in candidate['warnings'][len(base['warnings']):]),
            'Candidate adds warnings outside the authorized new issues.')
    return len(added)


def publish(api, manifest, catalog):
    require(catalog.is_file() and not catalog.is_symlink(), 'Candidate catalog is missing.')
    data = catalog.read_bytes()
    json.loads(data)
    if data == Path('data/catalog.json').read_bytes():
        sha = manifest['head_sha']
    else:
        mutation = '''mutation($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { oid } }
        }'''
        result = api.request('/graphql', {'query': mutation, 'variables': {'input': {
            'branch': {'repositoryNameWithOwner': api.repository, 'branchName': manifest['head_ref']},
            'expectedHeadOid': manifest['head_sha'],
            'message': {'headline': 'Import uploaded PDF batch'},
            'fileChanges': {'additions': [{'path': 'data/catalog.json',
                                           'contents': base64.b64encode(data).decode()}]},
        }}})
        require(not result.get('errors'), 'Atomic catalog commit was rejected.')
        sha = result['data']['createCommitOnBranch']['commit']['oid']
        require(bool(re.fullmatch(r'[0-9a-f]{40}', sha)), 'Invalid committed SHA.')
    api.request(api.root + '/check-runs', {'name': 'PDF upload candidate', 'head_sha': sha,
        'status': 'completed', 'conclusion': 'success', 'output': {
            'title': 'Validated PDF upload candidate',
            'summary': 'The trusted-base importer and independent validation completed for this exact catalog and PDF tree.'}})
    return sha


def auto_publish(api, manifest, head_sha):
    pr = api.get('/pulls/' + str(manifest['number']))
    base, head = pr['base'], pr['head']
    require(pr.get('state') == 'open' and not pr.get('draft'), 'Upload PR is no longer open and ready.')
    require(base['repo']['full_name'].lower() == api.repository.lower() and
            base['repo'].get('private') is False and head.get('repo') and
            head['repo']['id'] == base['repo']['id'], 'Upload repository changed before merge.')
    require(base['ref'] == manifest['base_ref'] and base['sha'] == manifest['base_sha'],
            'Base changed after validation; inspect the upload PR before retrying.')
    require(head['ref'] == manifest['head_ref'] and head['sha'] == head_sha,
            'Upload head changed after validation; refusing automatic merge.')
    if base['ref'] != base['repo']['default_branch']:
        return None
    result = api.request(api.root + f"/pulls/{manifest['number']}/merge",
                         {'sha': head_sha, 'merge_method': 'merge'}, method='PUT')
    require(result.get('merged') is True and bool(re.fullmatch(r'[0-9a-f]{40}', result.get('sha', ''))),
            'Automatic merge was rejected; inspect the upload PR.')
    # Token-created pushes do not trigger Actions; dispatch the normal guarded Pages workflow.
    api.request(api.root + '/actions/workflows/site.yml/dispatches', {'ref': base['ref']})
    return result['sha']


def main():
    if sys.argv[1] == 'validate':
        manifest = json.loads(Path('upload-manifest.json').read_text(encoding='utf-8'))
        count = validate_candidate(Path('data/catalog.json'), Path('upload-artifact/catalog.json'), manifest)
        print('Validated incremental issues:', count)
        return
    token = os.environ['GH_TOKEN']
    api = GitHub(token, os.environ['GITHUB_REPOSITORY'])
    number = int(os.environ['UPLOAD_PR_NUMBER'])
    args = (number, os.environ['UPLOAD_BASE_REF'], os.environ['UPLOAD_BASE_SHA'],
            os.environ['GITHUB_ACTOR'], os.environ['UPLOAD_TRIGGERING_ACTOR'],
            os.environ.get('UPLOAD_EXPECTED_HEAD', ''))
    current = eligible(api, *args)
    if sys.argv[1] == 'prepare':
        prepare(api, current)
        Path('upload-manifest.json').write_text(json.dumps(current, sort_keys=True), encoding='utf-8')
    elif sys.argv[1] == 'publish':
        previous = json.loads(Path('upload-artifact/upload-manifest.json').read_text(encoding='utf-8'))
        require(current == previous, 'PR changed while the candidate was being validated.')
        sha = publish(api, current, Path('upload-artifact/catalog.json'))
        print('Validated candidate SHA:', sha)
        merged = auto_publish(api, current, sha)
        if merged:
            print('Automatic publication queued for merged SHA:', merged)
        else:
            print('Non-default-branch test: candidate validated without merge or publication.')
    else:
        raise UploadError('Unknown upload operation.')


if __name__ == '__main__':
    try:
        main()
    except (UploadError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print('PDF upload stopped:', str(exc), file=sys.stderr)
        sys.exit(1)
