import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nannaweb.catalog import BuildError, build, project_document
from nannaweb.common import source_url


def item(title, kind='summary', cutoff='01-01', listed='12-30', urls=(), body=None):
    return {'kind': kind, 'title': title, 'category': '讲座',
            'body_text': body or f'活动：{title}\n截止时间：{cutoff}\n刊载时间：{listed}',
            'source_urls': list(urls), 'locator': {'page': 2},
            'dates': [{'kind': 'deadline', 'raw_text': cutoff},
                      {'kind': 'listed', 'raw_text': listed}] if kind == 'summary' else []}


def document(items, date='2026-12-31', number=1, digest='a' * 64):
    return {'issue_date': date, 'issue_number': number, 'title': 'Bulletin',
            'source_sha256': digest, 'items': items, 'warnings': [],
            'parser': {'version': '2.14.4'}}


def test_rollover_inclusive_and_table_cutoff_precedence():
    summary = item('活动', cutoff='01-01', listed='12-31')
    detail = item('活动', 'detail', body='报名截止时间：2026-12-31\n活动时间：晚上七点\n活动地点：大厅')
    _, entries, _ = project_document(document([summary, detail]), 'issue.pdf')
    entry = entries[0]
    assert entry['cutoff'] == '2027-01-01'
    assert entry['listed_on'] == '2026-12-31'
    assert entry['time'] == '晚上七点' and entry['location'] == '大厅'
    assert '报名截止时间：2026-12-31' in entry['text']
    _, entries, _ = project_document(document([item('活动', cutoff='12-31', listed='01-01')]), 'issue.pdf')
    assert entries[0]['cutoff'] == '2026-12-31'
    assert entries[0]['listed_on'] == '2026-01-01'
    _, entries, _ = project_document(document([item('活动', cutoff='01-01', listed='12-31')], date='2027-01-01'), 'issue.pdf')
    assert entries[0]['listed_on'] == '2026-12-31'
    assert entries[0]['cutoff'] == '2027-01-01'


def test_invalid_and_ambiguous_dates_preserved_with_warning():
    _, entries, warnings = project_document(document([item('活动', cutoff='02-30', listed='12-29至12-30')]), 'issue.pdf')
    assert entries[0]['cutoff'] is None and entries[0]['listed_on'] is None
    assert entries[0]['cutoff_raw'] == '02-30'
    assert {w['code'] for w in warnings} == {'unresolved_cutoff', 'unresolved_listed_on'}


def test_multiple_rows_last_cutoff_and_stable_identity():
    first = item('活动', cutoff='01-01')
    second = item('活动', cutoff='01-05')
    _, entries, _ = project_document(document([first, second]), 'issue.pdf')
    _, other, _ = project_document(document([second]), 'issue.pdf')
    assert len(entries) == 1 and entries[0]['cutoff'] == '2027-01-05'
    assert entries[0]['cutoff_raw'] == '01-01\n01-05'
    assert '01-01' in entries[0]['text'] and entries[0]['id'] == other[0]['id']


def test_unique_identity_merge_and_unmatched_notice():
    a = 'https://example.org/article/a'
    b = 'https://example.org/article/b'
    generic = 'https://nik-nul.github.io/news/2026-12-30'
    rows = [item('标题', urls=[a, generic]), item('标题', urls=[b, generic]),
            item('别名', 'detail', urls=[a], body='正文'),
            item('独立通知', 'notice', urls=[generic], body='独立正文')]
    _, entries, _ = project_document(document(rows), 'issue.pdf')
    assert len(entries) == 3
    assert next(e for e in entries if a in e['source_urls'])['text'].endswith('正文')
    assert next(e for e in entries if b in e['source_urls'])['id'] != entries[0]['id']
    notice = next(e for e in entries if e['title'] == '独立通知')
    assert notice['kind'] == 'notice' and notice['cutoff'] is None and notice['text'] == '独立正文'


def test_deduplicate_bytes_and_fail_atomic(tmp_path):
    inputs = tmp_path / 'input'
    inputs.mkdir()
    (inputs / 'a.pdf').write_bytes(b'one')
    (inputs / 'b.pdf').write_bytes(b'one')
    output = tmp_path / 'catalog.json'
    cache = tmp_path / 'cache'
    def parse(path, workdir):
        return document([item('活动')], digest=hashlib.sha256(Path(path).read_bytes()).hexdigest())
    with patch('nannaweb.catalog.parse_pdf', side_effect=parse) as parser:
        result = build(inputs, output, cache)
    assert parser.call_count == 1 and result['duplicate_pdfs'] == 1
    before = output.read_bytes()
    (inputs / 'c.pdf').write_bytes(b'two')
    with patch('nannaweb.catalog.parse_pdf', side_effect=parse):
        with pytest.raises(BuildError, match='issue metadata'):
            build(inputs, output, cache)
    assert output.read_bytes() == before
    assert len(json.loads(before)['issues']) == 1


def test_unsupported_layout_does_not_replace_catalog(tmp_path):
    inputs = tmp_path / 'input'
    inputs.mkdir()
    (inputs / 'a.pdf').write_bytes(b'one')
    output = tmp_path / 'catalog.json'
    output.write_text('old')
    bad = document([item('活动')], digest=hashlib.sha256(b'one').hexdigest())
    bad['warnings'] = [{'code': 'unsupported_table_row'}]
    with patch('nannaweb.catalog.parse_pdf', return_value=bad):
        with pytest.raises(BuildError):
            build(inputs, output, tmp_path / 'cache')
    assert output.read_text() == 'old'


def test_escaping_symlink_cannot_replace_catalog(tmp_path):
    inputs = tmp_path / 'input'
    inputs.mkdir()
    outside = tmp_path / 'outside.pdf'
    outside.write_bytes(b'outside')
    (inputs / 'escape.pdf').symlink_to(outside)
    output = tmp_path / 'catalog.json'
    output.write_text('old')
    with pytest.raises(BuildError, match='escapes'):
        build(inputs, output, tmp_path / 'cache')
    assert output.read_text() == 'old'


def test_safe_urls():
    assert source_url('javascript:alert(1)') is None
    assert source_url('https://user:pass@example.org/x') is None
    assert source_url('https://example.org/a\nheader') is None
    assert source_url('https://example.org/a?q=1&q=2#fragment') == 'https://example.org/a?q=1&q=2'


def test_recently_expired_cutoff_is_not_rolled_forward_a_year():
    _, entries, _ = project_document(document([item('活动', cutoff='11-01', listed='10-29')], date='2026-11-02'), 'issue.pdf')
    assert entries[0]['cutoff'] == '2026-11-01'


def test_chronological_last_cutoff_does_not_depend_on_table_order():
    _, entries, _ = project_document(document([item('活动', cutoff='01-05'), item('活动', cutoff='01-01')]), 'issue.pdf')
    assert entries[0]['cutoff'] == '2027-01-05'


def test_cross_year_leap_date_and_future_listed_date():
    _, entries, warnings = project_document(document([item('活动', cutoff='02-29', listed='01-01')], date='2027-12-31'), 'issue.pdf')
    assert entries[0]['cutoff'] == '2028-02-29'
    assert entries[0]['listed_on'] == '2027-01-01'
    _, entries, warnings = project_document(document([item('活动', cutoff='11-03', listed='11-03')], date='2026-11-02'), 'issue.pdf')
    assert entries[0]['listed_on'] is None
    assert any(warning['code'] == 'unresolved_listed_on' for warning in warnings)


def test_wrapped_location_is_complete_and_table_metadata_is_not_a_summary():
    detail = item('活动', 'detail', body='时间：11月2日 10:00\n地点：仙林校区十食堂三楼就业中心304会\n议室\n主讲人：甲')
    _, entries, _ = project_document(document([item('活动'), detail]), 'issue.pdf')
    assert entries[0]['location'] == '仙林校区十食堂三楼就业中心304会议室'
    assert entries[0]['summary'] == ''
    assert '主讲人：甲' in entries[0]['text']


def test_missing_first_source_cannot_hide_conflicting_later_sources():
    rows = [item('同名消息'), item('同名消息', urls=['https://example.org/a']), item('同名消息', urls=['https://example.org/b'])]
    _, entries, _ = project_document(document(rows), 'issue.pdf')
    assert len(entries) == 2
    assert all(len(entry['source_urls']) <= 1 for entry in entries)


def test_missing_first_listed_date_cannot_hide_conflicting_later_dates():
    first = item('同名消息')
    first['dates'] = [field for field in first['dates'] if field['kind'] != 'listed']
    _, entries, _ = project_document(document([first, item('同名消息', listed='12-29'), item('同名消息', listed='12-30')]), 'issue.pdf')
    assert {entry['listed_on'] for entry in entries} == {'2026-12-29', '2026-12-30'}


def test_wrapped_clock_time_is_not_a_new_metadata_label():
    detail = item('活动', 'detail', body='时间：12月3日（周四）\n18:30-20:00\n地点：大厅\n主讲人：甲')
    _, entries, _ = project_document(document([item('活动'), detail]), 'issue.pdf')
    assert entries[0]['time'] == '12月3日（周四） 18:30-20:00'
    assert entries[0]['location'] == '大厅'


def test_any_unresolved_constituent_keeps_merged_cutoff_unknown():
    rows = [item('活动', cutoff='01-01'), item('活动', cutoff='01-03至01-05')]
    _, entries, warnings = project_document(document(rows), 'issue.pdf')
    assert entries[0]['cutoff'] is None
    assert entries[0]['cutoff_raw'] == '01-01\n01-03至01-05'
    assert any(warning['code'] == 'unresolved_cutoff' for warning in warnings)
