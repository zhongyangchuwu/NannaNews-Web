import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nannaweb.catalog import BuildError, import_pdfs


URL = 'https://example.org/activity'


def item(key, title, kind='summary', *, listed='2026-12-30', url=URL, body='正文', category='讲座'):
    return {'local_key': key, 'kind': kind, 'title': title, 'category': category,
            'body_text': body, 'body_lines': [], 'primary_urls': [url] if url else [],
            'other_urls': [], 'locator': {'page': 2},
            'dates': [{'kind': 'deadline', 'raw_text': '2027-01-01'},
                      {'kind': 'listed', 'raw_text': listed}] if kind == 'summary' else []}


def document(data, items, day='2026-12-31', number=2):
    return {'schema_version': 1, 'issue_date': day, 'issue_number': number,
            'title': 'Bulletin', 'source_sha256': hashlib.sha256(data).hexdigest(),
            'items': items, 'warnings': [],
            'parser': {'version': '2.14.4', 'text_layer': 'poppler-xml-1'}}


def run_import(tmp_path, documents, legacy=None):
    inputs = tmp_path / 'input'
    inputs.mkdir(exist_ok=True)
    def parse(path, workdir):
        return documents[Path(path).read_bytes()]
    with patch('nannaweb.catalog.parse_pdf', side_effect=parse) as parser:
        result = import_pdfs(inputs, tmp_path / 'catalog.json', tmp_path / 'cache', legacy)
    return json.loads((tmp_path / 'catalog.json').read_text()), result, parser.call_count


def put(tmp_path, name, data):
    inputs = tmp_path / 'input'
    inputs.mkdir(exist_ok=True)
    (inputs / name).write_bytes(data)


def test_incremental_supplement_preserves_identity_and_source_facts(tmp_path):
    new, old = b'new', b'old'
    put(tmp_path, 'new.pdf', new)
    docs = {new: document(new, [item('r', '公开讲座', listed='2026-12-30')]),
            old: document(old, [item('d', '公开讲座：完整标题', 'detail', body='历史说明')],
                          day='2026-12-30', number=1)}
    first, _, _ = run_import(tmp_path, docs)
    aid = first['activities'][0]['id']
    original_row = first['listings'][0]
    put(tmp_path, 'old.pdf', old)
    master, result, calls = run_import(tmp_path, docs)
    assert result['issues_added'] == 1 and calls == 1
    assert master['activities'] == [{'id': aid}]
    assert master['listings'] == [original_row]
    assert master['details'][0]['text'] == '历史说明'
    assert {p['activity_id'] for p in master['publications']} == {aid}
    assert next(p for p in master['publications'] if p['listing_ids'])['detail_id'] is None
    before = (tmp_path / 'catalog.json').read_bytes()
    (tmp_path / 'input' / 'new.pdf').rename(tmp_path / 'input' / 'renamed.pdf')
    _, result, calls = run_import(tmp_path, docs)
    assert calls == 0 and result['issues_added'] == 0
    assert (tmp_path / 'catalog.json').read_bytes() == before


def test_detail_first_then_listing_associates(tmp_path):
    old, new = b'old', b'new'
    docs = {old: document(old, [item('d', '公开讲座：完整标题', 'detail')], '2026-12-30', 1),
            new: document(new, [item('r', '公开讲座')])}
    put(tmp_path, 'old.pdf', old)
    first, _, _ = run_import(tmp_path, docs)
    put(tmp_path, 'new.pdf', new)
    master, _, _ = run_import(tmp_path, docs)
    assert master['activities'] == first['activities']
    assert len(master['publications']) == 2


def test_source_order_and_duplicate_rows_are_independent_facts(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('a1', '甲'), item('b', '乙', url='https://example.org/b'),
                                  item('a2', '甲'), item('da', '甲', 'detail'),
                                  item('db', '乙', 'detail', url='https://example.org/b')])}
    master, _, _ = run_import(tmp_path, docs)
    assert [s['title'] for s in master['listings']] == ['甲', '乙', '甲']
    assert [s['order'] for s in master['listings']] == [0, 1, 2]
    assert [s['order'] for s in master['details']] == [3, 4]
    assert len({s['id'] for s in master['listings'] + master['details']}) == 5
    assert sorted(len(p['listing_ids']) for p in master['publications']) == [1, 2]


def test_same_title_and_series_url_do_not_join_unrelated_issues(tmp_path):
    old, new = b'old', b'new'
    docs = {old: document(old, [item('d', '系列讲座', 'detail', body='第一场')], '2026-12-29', 1),
            new: document(new, [item('r', '系列讲座', listed='2026-12-31'),
                                item('d', '系列讲座', 'detail', body='第二场')])}
    put(tmp_path, 'old.pdf', old)
    put(tmp_path, 'new.pdf', new)
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['activities']) == 2
    assert len({p['activity_id'] for p in master['publications']}) == 2


def test_ambiguous_similar_rows_and_bodies_are_not_forced_together(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('a', '系列讲座'), item('b', '系列讲座'),
                                  item('d1', '系列讲座', 'detail', body='第一场'),
                                  item('d2', '系列讲座', 'detail', body='第二场')])}
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['activities']) == 4
    assert len(master['listings']) == len(master['details']) == 2


def test_conflicting_issue_and_bad_batch_leave_master_unchanged(tmp_path):
    first, conflict, valid = b'first', b'conflict', b'valid'
    put(tmp_path, 'a.pdf', first)
    docs = {first: document(first, [item('a', '甲')]),
            conflict: document(conflict, [item('b', '乙')]),
            valid: document(valid, [item('c', '丙')], '2026-12-29', 1)}
    run_import(tmp_path, docs)
    before = (tmp_path / 'catalog.json').read_bytes()
    put(tmp_path, 'b.pdf', valid)
    put(tmp_path, 'c.pdf', conflict)
    with pytest.raises(BuildError, match='duplicate issue'):
        run_import(tmp_path, docs)
    assert (tmp_path / 'catalog.json').read_bytes() == before


def test_old_unsealed_cache_is_never_accepted(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    bundle = tmp_path / 'cache' / '2.14.4-reader-2' / hashlib.sha256(data).hexdigest()
    bundle.mkdir(parents=True)
    (bundle / 'document.json').write_text('{}')
    master, _, calls = run_import(tmp_path, {data: document(data, [item('a', '甲')])})
    assert calls == 1 and len(master['issues']) == 1


def test_invalid_graph_rejected_without_replacement(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('a', '甲')])}
    master, _, _ = run_import(tmp_path, docs)
    master['publications'][0]['listing_ids'] = ['missing']
    path = tmp_path / 'catalog.json'
    path.write_text(json.dumps(master))
    before = path.read_bytes()
    with pytest.raises(BuildError, match='source'):
        run_import(tmp_path, docs)
    assert path.read_bytes() == before


def test_migrate_unique_alias_and_leave_ambiguous_id_unresolved(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('a', '甲'), item('b', '乙', url='https://example.org/b')])}
    master, _, _ = run_import(tmp_path, docs)
    def old_listing(source):
        return {key: source[key] for key in ('title', 'cutoff', 'cutoff_raw', 'listed_on', 'listed_raw', 'source_urls', 'page')}
    a, b = map(old_listing, master['listings'])
    old_issue = {'id': 'old', 'sha256': master['issues'][0]['sha256']}
    def entry(identifier, listing):
        return {'id': identifier, 'issue_id': 'old', 'category': '讲座', 'listings': [listing], 'detail': None}
    legacy = tmp_path / 'legacy.json'
    legacy.write_text(json.dumps({'schema_version': 2, 'issues': [old_issue],
                                  'entries': [entry('saved', a), entry('ambiguous', a), entry('ambiguous', b)]}))
    updated, result, _ = run_import(tmp_path, docs, legacy)
    aid = next(p['activity_id'] for p in updated['publications'] if updated['listings'][0]['id'] in p['listing_ids'])
    assert updated['identity_aliases'] == [{'legacy_id': 'saved', 'activity_id': aid}]
    assert result['aliases_added'] == 1 and result['unresolved_legacy_ids'] == 1
    assert updated['listings'] == master['listings']


def test_missing_source_local_key_rejects_entire_batch(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    bad = item('a', '甲')
    del bad['local_key']
    with pytest.raises(BuildError, match='source evidence'):
        run_import(tmp_path, {data: document(data, [bad])})
    assert not (tmp_path / 'catalog.json').exists()


@pytest.mark.parametrize('mutation', ['extra_key', 'cross_issue', 'duplicate_source', 'unreferenced_activity'])
def test_invalid_graph_shapes_fail_atomically(tmp_path, mutation):
    a, b = b'a', b'b'
    put(tmp_path, 'a.pdf', a)
    put(tmp_path, 'b.pdf', b)
    docs = {a: document(a, [item('a', '甲')]),
            b: document(b, [item('b', '乙', url='https://example.org/b')], '2026-12-30', 1)}
    master, _, _ = run_import(tmp_path, docs)
    if mutation == 'extra_key':
        master['activities'][0]['title'] = 'not a source fact'
    elif mutation == 'cross_issue':
        master['publications'][0]['listing_ids'] = [master['listings'][1]['id']]
    elif mutation == 'duplicate_source':
        master['publications'][0]['listing_ids'].append(master['publications'][0]['listing_ids'][0])
    else:
        master['activities'].append({'id': 'orphan'})
    path = tmp_path / 'catalog.json'
    path.write_text(json.dumps(master))
    before = path.read_bytes()
    with pytest.raises(BuildError):
        run_import(tmp_path, docs)
    assert path.read_bytes() == before


def test_invalid_legacy_rejects_new_batch_atomically(tmp_path):
    a, b = b'a', b'b'
    docs = {a: document(a, [item('a', '甲')]),
            b: document(b, [item('b', '乙')], '2026-12-30', 1)}
    put(tmp_path, 'a.pdf', a)
    run_import(tmp_path, docs)
    before = (tmp_path / 'catalog.json').read_bytes()
    put(tmp_path, 'b.pdf', b)
    legacy = tmp_path / 'legacy.json'
    legacy.write_text('{invalid')
    with pytest.raises(BuildError, match='legacy identity catalog'):
        run_import(tmp_path, docs, legacy)
    assert (tmp_path / 'catalog.json').read_bytes() == before


def test_same_day_distinct_issue_numbers_are_allowed(tmp_path):
    a, b = b'a', b'b'
    put(tmp_path, 'a.pdf', a)
    put(tmp_path, 'b.pdf', b)
    docs = {a: document(a, [item('a', '甲')], number=1),
            b: document(b, [item('b', '乙')], number=2)}
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['issues']) == 2


def test_extracts_detail_fields_without_changing_text(tmp_path):
    data = b'one'
    detail = item('d', '讲座', 'detail', body='地点：大厅')
    detail['body_lines'] = [{'text': '地点：大厅', 'x': 10, 'y': 0, 'width': 50,
                             'height': 10, 'page': 2, 'paragraph': 0, 'column_right': 110}]
    put(tmp_path, 'one.pdf', data)
    master, _, _ = run_import(tmp_path, {data: document(data, [detail])})
    assert master['details'][0]['text'] == '地点：大厅'
    assert master['details'][0]['fields'] == [{'label': '地点', 'value': '大厅'}]


def test_shared_series_source_allows_disambiguating_title_variant(tmp_path):
    old, new = b'old', b'new'
    put(tmp_path, 'old.pdf', old)
    old_items = [item('d1', '公开讲座：完整标题', 'detail'),
                 item('d2', '其他系列讲座', 'detail')]
    docs = {old: document(old, old_items, '2026-12-30', 1),
            new: document(new, [item('r', '公开讲座')])}
    first, _, _ = run_import(tmp_path, docs)
    put(tmp_path, 'new.pdf', new)
    master, _, _ = run_import(tmp_path, docs)
    assert len(first['activities']) == 2
    assert len(master['activities']) == 2


@pytest.mark.parametrize('mutation', ['orphan_issue', 'duplicate_hash', 'blank_title', 'blank_label', 'blank_value'])
def test_rejects_invalid_issue_and_detail_facts(tmp_path, mutation):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('d', '活动', 'detail', body='正文')])}
    master, _, _ = run_import(tmp_path, docs)
    if mutation in ('orphan_issue', 'duplicate_hash'):
        issue = dict(master['issues'][0], id='other', date='2026-12-29', number=1)
        if mutation == 'orphan_issue':
            issue['sha256'] = 'f' * 64
        master['issues'].append(issue)
    elif mutation == 'blank_title':
        master['details'][0]['title'] = '  '
    else:
        master['details'][0]['fields'] = [{'label': ' ', 'value': 'ok'} if mutation == 'blank_label'
                                          else {'label': 'ok', 'value': ' '}]
    path = tmp_path / 'catalog.json'
    path.write_text(json.dumps(master))
    before = path.read_bytes()
    with pytest.raises(BuildError):
        run_import(tmp_path, docs)
    assert path.read_bytes() == before


def test_listing_continuity_without_original_issue(tmp_path):
    earlier, later = b'earlier', b'later'
    put(tmp_path, 'earlier.pdf', earlier)
    docs = {earlier: document(earlier, [item('r1', '公开讲座', listed='2026-12-28')], '2026-12-30', 1),
            later: document(later, [item('r2', '公开讲座', listed='2026-12-28')])}
    first, _, _ = run_import(tmp_path, docs)
    put(tmp_path, 'later.pdf', later)
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['issues']) == 2
    assert master['activities'] == first['activities']
    assert len(master['publications']) == 2
    assert len(master['listings']) == 2


def test_shared_series_url_matches_distinct_exact_titles(tmp_path):
    earlier, later = b'earlier', b'later'
    put(tmp_path, 'earlier.pdf', earlier)
    docs = {earlier: document(earlier, [item('a', '系列讲座：第一讲', listed='2026-12-28'),
                                       item('b', '系列讲座：第二讲', listed='2026-12-28')], '2026-12-30', 1),
            later: document(later, [item('c', '系列讲座：第二讲', listed='2026-12-28'),
                                   item('d', '系列讲座：第一讲', listed='2026-12-28')])}
    first, _, _ = run_import(tmp_path, docs)
    put(tmp_path, 'later.pdf', later)
    master, _, _ = run_import(tmp_path, docs)
    assert master['activities'] == first['activities']
    by_source = {sid: p['activity_id'] for p in master['publications'] for sid in p['listing_ids']}
    by_title = {}
    for source in master['listings']:
        by_title.setdefault(source['title'], set()).add(by_source[source['id']])
    assert len(by_title) == 2 and all(len(ids) == 1 for ids in by_title.values())
    assert len(set.union(*by_title.values())) == 2


def test_legacy_issue_id_without_matching_sha_does_not_create_alias(tmp_path):
    data = b'one'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('r', '活动')])}
    master, _, _ = run_import(tmp_path, docs)
    listing = {key: master['listings'][0][key] for key in
               ('title', 'cutoff', 'cutoff_raw', 'listed_on', 'listed_raw', 'source_urls', 'page')}
    legacy = tmp_path / 'legacy.json'
    legacy.write_text(json.dumps({'schema_version': 2,
                                  'issues': [{'id': master['issues'][0]['id'], 'sha256': 'f' * 64}],
                                  'entries': [{'id': 'saved', 'issue_id': master['issues'][0]['id'],
                                               'listings': [listing], 'detail': None}]}))
    updated, result, _ = run_import(tmp_path, docs, legacy)
    assert updated['identity_aliases'] == []
    assert result['unresolved_legacy_ids'] == 1


def test_equal_best_cross_issue_candidates_remain_unmerged(tmp_path):
    older, newer = b'older', b'newer'
    put(tmp_path, 'older.pdf', older)
    docs = {older: document(older, [item('a', '系列讲座：标题甲', 'detail'),
                                   item('b', '系列讲座：标题乙', 'detail')], '2026-12-30', 1),
            newer: document(newer, [item('c', '系列讲座', listed='2026-12-30')])}
    first, _, _ = run_import(tmp_path, docs)
    assert first['issues'][0]['extraction_version'] == '2.14.4-poppler-xml-1-canonical-3'
    put(tmp_path, 'newer.pdf', newer)
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['activities']) == 3


def test_unique_origin_pairs_noncontained_detail_and_backfills(tmp_path):
    older, newer = b'older', b'newer'
    short, full = '3D设计大赛', '第四届3D制作竞赛'
    docs = {older: document(older, [item('r1', short, listed='2026-12-30'),
                                   item('d', full, 'detail', body='完整说明')], '2026-12-30', 1),
            newer: document(newer, [item('r2', short, listed='2026-12-30')])}
    put(tmp_path, 'newer.pdf', newer)
    first, _, _ = run_import(tmp_path, docs)
    put(tmp_path, 'older.pdf', older)
    master, _, _ = run_import(tmp_path, docs)
    assert master['activities'] == first['activities']
    old_pub = next(p for p in master['publications'] if p['detail_id'])
    assert old_pub['activity_id'] == first['activities'][0]['id']
    assert len(old_pub['listing_ids']) == 1
    assert master['details'][0]['title'] == full


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('siblings', [False, True])
def test_conflicting_listing_origins_never_bridge_via_sibling_details(tmp_path, reverse, siblings):
    older, newer = b'older', b'newer'
    old_items = [item('r1', '系列讲座', listed='2026-12-29')]
    new_items = [item('r2', '系列讲座', listed='2026-12-30')]
    if siblings:
        old_items.append(item('d1', '系列讲座', 'detail', body='旧场'))
        new_items.append(item('d2', '系列讲座', 'detail', body='新场'))
    docs = {older: document(older, old_items, '2026-12-30', 1),
            newer: document(newer, new_items)}
    first, second = (newer, older) if reverse else (older, newer)
    put(tmp_path, 'first.pdf', first)
    run_import(tmp_path, docs)
    put(tmp_path, 'second.pdf', second)
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['activities']) == 2
    assert len({p['activity_id'] for p in master['publications']}) == 2


@pytest.mark.parametrize('change', ['malformed', 'unmatched'])
def test_legacy_entry_requires_every_source_to_match(tmp_path, change):
    data, added = b'one', b'two'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('r', '甲')]),
            added: document(added, [item('other', '乙')], '2026-12-29', 1)}
    master, _, _ = run_import(tmp_path, docs)
    keys = ('title', 'cutoff', 'cutoff_raw', 'listed_on', 'listed_raw', 'source_urls', 'page')
    listing = {key: master['listings'][0][key] for key in keys}
    second = {} if change == 'malformed' else {**listing, 'title': '未匹配'}
    legacy = tmp_path / 'legacy.json'
    legacy.write_text(json.dumps({'schema_version': 2, 'issues': master['issues'],
                                  'entries': [{'id': 'saved', 'issue_id': master['issues'][0]['id'],
                                               'listings': [listing, second], 'detail': None}]}))
    before = (tmp_path / 'catalog.json').read_bytes()
    put(tmp_path, 'two.pdf', added)
    if change == 'malformed':
        with pytest.raises(BuildError, match='invalid entries'):
            run_import(tmp_path, docs, legacy)
        assert (tmp_path / 'catalog.json').read_bytes() == before
    else:
        result, summary, _ = run_import(tmp_path, docs, legacy)
        assert not result['identity_aliases']
        assert summary['unresolved_legacy_ids'] == 1


@pytest.mark.parametrize('change', ['ambiguous', 'contradictory', 'unmatched'])
@pytest.mark.parametrize('reverse', [False, True])
def test_changed_legacy_evidence_cannot_leave_existing_alias(tmp_path, change, reverse):
    data, added = b'one', b'two'
    put(tmp_path, 'one.pdf', data)
    docs = {data: document(data, [item('a', '甲'), item('b', '乙', url='https://example.org/b')]),
            added: document(added, [item('c', '丙')], '2026-12-29', 1)}
    master, _, _ = run_import(tmp_path, docs)
    keys = ('title', 'cutoff', 'cutoff_raw', 'listed_on', 'listed_raw', 'source_urls', 'page')
    a, b = [{key: source[key] for key in keys} for source in master['listings']]
    if reverse:
        a, b = b, a
    def entry(listing):
        return {'id': 'saved', 'issue_id': master['issues'][0]['id'], 'listings': [listing], 'detail': None}
    legacy = tmp_path / 'legacy.json'
    def save(entries):
        legacy.write_text(json.dumps({'schema_version': 2, 'issues': master['issues'], 'entries': entries}))
    save([entry(a)])
    run_import(tmp_path, docs, legacy)
    before = (tmp_path / 'catalog.json').read_bytes()
    changed = [entry(a), entry(b)] if change == 'ambiguous' else [entry(b if change == 'contradictory' else {**a, 'title': '未匹配'})]
    save(changed)
    put(tmp_path, 'two.pdf', added)
    with pytest.raises(BuildError, match='existing identity alias'):
        run_import(tmp_path, docs, legacy)
    assert (tmp_path / 'catalog.json').read_bytes() == before


@pytest.mark.parametrize(('old_url', 'new_url'), [('', ''), (URL, ''), ('', URL)])
@pytest.mark.parametrize('reverse', [False, True])
def test_linkless_exact_title_continues_with_shared_listed_date(tmp_path, old_url, new_url, reverse):
    older, newer = b'older', b'newer'
    docs = {older: document(older, [item('r1', '艺术无界时代下的诗歌践行',
                                        listed='2026-12-28', url=old_url)], '2026-12-30', 1),
            newer: document(newer, [item('r2', '艺术无界时代下的诗歌践行',
                                        listed='2026-12-28', url=new_url)])}
    first, second = (newer, older) if reverse else (older, newer)
    put(tmp_path, 'first.pdf', first)
    initial, _, _ = run_import(tmp_path, docs)
    put(tmp_path, 'second.pdf', second)
    master, _, _ = run_import(tmp_path, docs)
    assert master['activities'] == initial['activities']
    assert len(master['publications']) == 2
    assert {row['listed_on'] for row in master['listings']} == {'2026-12-28'}
    assert all(issue['date'] != '2026-12-28' for issue in master['issues'])


@pytest.mark.parametrize('siblings', [False, True])
def test_dated_exact_title_with_disjoint_known_links_stays_separate(tmp_path, siblings):
    older, newer = b'older', b'newer'
    old_items = [item('r1', '同名讲座', listed='2026-12-28', url='https://example.org/one')]
    new_items = [item('r2', '同名讲座', listed='2026-12-28', url='https://example.org/two')]
    if siblings:
        old_items.append(item('d1', '同名讲座', 'detail', url=''))
        new_items.append(item('d2', '同名讲座', 'detail', url=''))
    docs = {older: document(older, old_items, '2026-12-30', 1),
            newer: document(newer, new_items)}
    put(tmp_path, 'older.pdf', older)
    run_import(tmp_path, docs)
    put(tmp_path, 'newer.pdf', newer)
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['activities']) == 2


def test_linkless_title_without_origin_date_does_not_merge(tmp_path):
    older, newer = b'older', b'newer'
    docs = {older: document(older, [item('d1', '同名讲座', 'detail', url='')], '2026-12-30', 1),
            newer: document(newer, [item('d2', '同名讲座', 'detail', url='')])}
    put(tmp_path, 'older.pdf', older)
    run_import(tmp_path, docs)
    put(tmp_path, 'newer.pdf', newer)
    master, _, _ = run_import(tmp_path, docs)
    assert len(master['activities']) == 2
