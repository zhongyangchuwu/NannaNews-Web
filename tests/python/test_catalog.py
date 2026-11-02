import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nannaweb.catalog import BuildError, CACHE_FORMAT, build, project_document
from nannaweb.common import source_url


def item(title, kind='summary', cutoff='01-01', listed='12-30', urls=(), body=None, other=(), lines=None):
    body = body if body is not None else f'活动：{title}\n截止时间：{cutoff}\n刊载时间：{listed}'
    return {'kind': kind, 'title': title, 'category': '讲座', 'body_text': body,
            'body_lines': lines or [], 'source_urls': list(urls) + list(other),
            'primary_urls': list(urls), 'other_urls': list(other), 'locator': {'page': 2},
            'dates': [{'kind': 'deadline', 'raw_text': cutoff},
                      {'kind': 'listed', 'raw_text': listed}] if kind == 'summary' else []}


def document(items, date='2026-12-31', number=1, digest='a' * 64):
    return {'issue_date': date, 'issue_number': number, 'title': 'Bulletin',
            'source_sha256': digest, 'items': items, 'warnings': [],
            'parser': {'version': '2.14.4'}}


def project(items, date='2026-12-31'):
    return project_document(document(items, date=date), 'issue.pdf')[1:]


def visual(*texts):
    return [{'text': text, 'x': 10, 'y': i * 12, 'width': width,
             'height': 10, 'page': 2, 'paragraph': 0, 'column_right': 110}
            for i, (text, width) in enumerate(texts)]


def test_rows_and_detail_are_distinct_and_cutoff_is_not_registration():
    rows = [item('活动', cutoff='01-01', listed='12-31'),
            item('活动', cutoff='01-05', listed='12-31'),
            item('活动', 'detail', body='报名截止时间：2026-12-31\n活动时间：晚上七点')]
    entries, _ = project(rows)
    entry = entries[0]
    assert set(entry) == {'id', 'issue_id', 'category', 'listings', 'detail'}
    assert [row['cutoff'] for row in entry['listings']] == ['2027-01-01', '2027-01-05']
    assert all(row['listed_on'] == '2026-12-31' for row in entry['listings'])
    assert entry['detail']['fields'] == [{'label': '报名截止时间', 'value': '2026-12-31'},
                                         {'label': '活动时间', 'value': '晚上七点'}]
    assert entry['detail']['text'] == rows[-1]['body_text']
    other, _ = project([rows[1]])
    assert entry['id'] == other[0]['id']


def test_dates_preserve_raw_and_rollover():
    entries, warnings = project([item('活动', cutoff='02-30', listed='12-29至12-30')])
    listing = entries[0]['listings'][0]
    assert (listing['cutoff'], listing['listed_on']) == (None, None)
    assert (listing['cutoff_raw'], listing['listed_raw']) == ('02-30', '12-29至12-30')
    assert {w['code'] for w in warnings} == {'unresolved_cutoff', 'unresolved_listed_on'}
    entries, _ = project([item('活动', cutoff='11-01', listed='10-29')], '2026-11-02')
    assert entries[0]['listings'][0]['cutoff'] == '2026-11-01'
    entries, _ = project([item('活动', cutoff='02-29', listed='01-01')], '2027-12-31')
    assert entries[0]['listings'][0]['cutoff'] == '2028-02-29'
    entries, warnings = project([item('活动', cutoff='11-03', listed='11-03')], '2026-11-02')
    assert entries[0]['listings'][0]['listed_on'] is None
    assert any(w['code'] == 'unresolved_listed_on' for w in warnings)


@pytest.mark.parametrize(('short', 'full'), [
    ('甲--乙', '甲——乙'), ('“甲乙”讲座', '"甲乙"讲座'),
    ('ＡＢＣ研究', 'ABC研究'), ('甲 乙 丙 丁', '甲乙丙丁'),
    ('城市研究', '城市研究系列讲座'), ('文化探讨', '文化探讨与交流'),
    ('人工智能讲座', '人工智能讲座：最新进展'), ('科学技术论坛', '科学技术论坛活动'),
    ('未来发展研究', '未来发展研究主题报告'), ('大学教育讲座', '大学教育讲座（某学院）'),
])
def test_title_variants_associate_with_shared_source(short, full):
    url = 'https://example.org/article'
    entries, _ = project([item(short, urls=[url]), item(full, 'detail', urls=[url], body='正文')])
    assert len(entries) == 1
    assert entries[0]['listings'][0]['title'] == short
    assert entries[0]['detail']['title'] == full


def test_shared_uri_does_not_merge_distinct_subjects():
    url = 'https://example.org/series'
    rows = [item(f'图书馆专题讲座主题{i:02d}', urls=[url]) for i in range(17)]
    details = [item(f'图书馆专题讲座主题{i:02d}', 'detail', urls=[url], body=f'正文{i}') for i in range(17)]
    entries, _ = project(rows + details)
    assert len(entries) == 17
    assert all(e['detail']['title'] == e['listings'][0]['title'] for e in entries)
    assert len({e['id'] for e in entries}) == 17
    entries, _ = project([item('完全不同标题', urls=[url]),
                          item('另一个标题', 'detail', urls=[url]),
                          item('第三个标题', 'detail', urls=[url])])
    assert len(entries) == 3


def test_unique_primary_source_pairs_different_titles_only_with_compatible_category():
    url = 'https://example.org/article#section'
    row = item('午间交流', urls=[url])
    detail = item('某学院联合举办主题对谈', 'detail', urls=[url], body='正文')
    entries, _ = project([row, detail])
    assert len(entries) == 1
    assert entries[0]['listings'][0]['title'] == row['title']
    assert entries[0]['detail']['title'] == detail['title']
    detail['category'] = '活动'
    entries, _ = project([row, detail])
    assert len(entries) == 2


def test_same_title_disjoint_sources_and_dates_stay_distinct():
    rows = [item('同名消息'), item('同名消息', urls=['https://example.org/a']),
            item('同名消息', urls=['https://example.org/b'])]
    entries, _ = project(rows)
    assert len(entries) == 2 and len({e['id'] for e in entries}) == 2
    first = item('同名消息')
    first['dates'] = [d for d in first['dates'] if d['kind'] != 'listed']
    entries, _ = project([first, item('同名消息', listed='12-29'), item('同名消息', listed='12-30')])
    assert len(entries) == 2
    assert {row['listed_on'] for e in entries for row in e['listings'] if row['listed_on']} == {'2026-12-29', '2026-12-30'}

@pytest.mark.parametrize(('first', 'second'), [
    ('文化研究第一讲', '文化研究第二讲'),
    ('阅读交流会第一场', '阅读交流会第二场'),
    ('甲学院校园歌唱大赛', '乙学院校园歌唱大赛'),
])
def test_related_events_with_shared_source_remain_distinct(first, second):
    url = 'https://example.org/series'
    entries, _ = project([item(first, urls=[url]), item(second, urls=[url]),
                          item(first, 'detail', urls=[url]), item(second, 'detail', urls=[url])])
    assert len(entries) == 2
    assert {e['detail']['title'] for e in entries} == {first, second}
    assert all(e['detail']['title'] == e['listings'][0]['title'] for e in entries)


def test_same_title_disjoint_fragments_are_distinct():
    entries, _ = project([item('同名消息', urls=['https://example.org/a#one']),
                          item('同名消息', urls=['https://example.org/a#two'])])
    assert len(entries) == 2
    assert len({e['id'] for e in entries}) == 2


def test_ambiguous_containment_does_not_merge():
    url = 'https://example.org/series'
    entries, _ = project([item('读书活动', urls=[url]), item('读书活动一', 'detail', urls=[url]),
                          item('读书活动二', 'detail', urls=[url])])
    assert len(entries) == 3


def test_literal_url_roles_and_safety():
    title_url = 'https://example.org/path#section'
    backlink = 'https://example.org/old#issue'
    detail_primary = 'https://example.org/'
    other = 'https://example.org/more#part'
    row = item('活动', urls=[title_url])
    row['source_urls'].append(backlink)
    detail = item('活动', 'detail', urls=[title_url, detail_primary], other=[other, 'javascript:alert(1)'])
    entries, _ = project([row, detail])
    assert entries[0]['listings'][0]['source_urls'] == [title_url]
    assert entries[0]['detail']['source_urls'] == [title_url, detail_primary]
    assert entries[0]['detail']['other_urls'] == [other]
    assert source_url('javascript:alert(1)') is None
    assert source_url('https://user:pass@example.org/x') is None
    assert source_url('https://example.org/a\nheader') is None


def test_generic_fields_wrap_clock_and_unlabelled_prose():
    lines = visual(('报名截止时间：12月3日', 100), ('18:30-20:00', 50),
                   ('集合地点：某校区中心会议', 100), ('室', 10),
                   ('主办单位：某研究所', 60), ('面向全体同学', 60),
                   ('请扫码报名', 40), ('欢迎参加', 40))
    body = '\n'.join(line['text'] for line in lines)
    entries, warnings = project([item('活动', 'detail', body=body, lines=lines)])
    detail = entries[0]['detail']
    assert detail['text'] == body
    assert detail['fields'] == [{'label': '报名截止时间', 'value': '12月3日 18:30-20:00'},
                                {'label': '集合地点', 'value': '某校区中心会议室'},
                                {'label': '主办单位', 'value': '某研究所'}]
    assert not warnings


def test_uri_and_weekday_clock_are_not_field_labels():
    uri = 'https://example.org/path#part'
    lines = visual(('开放时间：每周', 100), ('周五18:30-20:00', 50),
                   ('材料类型（甲）：电子版', 100), (uri, 50), ('mailto:info@example.org', 50))
    body = '\n'.join(line['text'] for line in lines)
    entries, warnings = project([item('活动', 'detail', body=body, lines=lines,
                                      other=[uri])])
    detail = entries[0]['detail']
    assert detail['fields'] == [{'label': '开放时间', 'value': '每周 周五18:30-20:00'},
                                {'label': '材料类型（甲）', 'value': '电子版'}]
    assert detail['text'] == body
    assert detail['other_urls'] == [uri]
    assert not warnings


def test_wrapped_parenthesized_colon_is_not_a_new_outer_label():
    lines = visual(('提交方式：发送材料（邮件标', 100), ('题：申请表）', 50))
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '提交方式', 'value': '发送材料（邮件标题：申请表）'}]
    assert not warnings


def test_wrapped_unclosed_value_tolerates_subpoint_edge_rounding():
    lines = visual(('申请日期：3月2日（甲类', 89.82), ('对象及相关说明', 50), ('详情）', 50))
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '申请日期', 'value': '3月2日（甲类对象及相关说明详情）'}]
    assert not warnings


@pytest.mark.parametrize(('first', 'second', 'value'), [
    ('嘉宾：甲（某研究部门', '主任）、乙（另一机构）', '甲（某研究部门主任）、乙（另一机构）'),
    ('活动内容：音乐（民谣、', '摇滚）与交流', '音乐（民谣、摇滚）与交流'),
    ('申请方式：邮件（联系：李老师', '123456789）', '邮件（联系：李老师 123456789）'),
])
def test_unclosed_delimiter_with_adjacent_short_continuation(first, second, value):
    lines = visual((first, 50), (second, 50), ('联系人：甲', 40))
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'][0]['value'] == value
    assert not warnings


def test_short_unfinished_conjunction_does_not_consume_note():
    lines = visual(('申请方式：填写表格并', 50), ('扫码领取纪念品', 50))
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == []
    assert [w['code'] for w in warnings] == ['uncertain_field_boundary']


def test_wrapped_instruction_is_not_discarded_as_unlabelled_note():
    lines = visual(('申请办法：填写表单并', 100), ('扫码加入群组', 50), ('联系人：甲', 40))
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '申请办法', 'value': '填写表单并扫码加入群组'},
                                               {'label': '联系人', 'value': '甲'}]
    assert not warnings


def test_unclosed_field_without_trusted_continuation_is_not_published():
    lines = visual(('提交方式：发送材料（邮件标', 50), ('题：申请表）', 50))
    for line in lines:
        del line['column_right']
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == []
    assert [w['code'] for w in warnings] == ['uncertain_field_boundary']


def test_known_short_boundary_finishes_field_before_note():
    lines = visual(('材料要求：请提交材料', 50), ('附加说明文字', 40), ('联系人：甲', 40))
    entries, warnings = project([item('活动', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '材料要求', 'value': '请提交材料'},
                                               {'label': '联系人', 'value': '甲'}]
    assert '附加说明文字' in entries[0]['detail']['text']
    assert not warnings


def test_unknown_short_boundary_remains_uncertain():
    lines = visual(('材料要求：请提交材料', 50), ('附加说明文字', 40), ('联系人：甲', 40))
    for line in lines:
        del line['column_right']
    entries, warnings = project([item('活动', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '联系人', 'value': '甲'}]
    assert '附加说明文字' in entries[0]['detail']['text']
    assert [w['code'] for w in warnings] == ['uncertain_field_boundary']


def test_link_footer_is_text_and_url_not_a_partial_field():
    uri = 'https://example.org/article#part'
    lines = visual(('联系人：某人', 50), ('详见：https://example.', 100), ('org/article#part', 50))
    body = '\n'.join(line['text'] for line in lines)
    entries, warnings = project([item('活动', 'detail', body=body, lines=lines, urls=[uri])])
    assert entries[0]['detail']['fields'] == [{'label': '联系人', 'value': '某人'}]
    assert entries[0]['detail']['text'] == body
    assert entries[0]['detail']['source_urls'] == [uri]
    assert not warnings


def test_missing_column_boundary_does_not_assert_wrapped_field():
    lines = visual(('地点：校区会议', 100), ('室', 10), ('联系人：甲', 40))
    for line in lines:
        del line['column_right']
    entries, warnings = project([item('活动', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '联系人', 'value': '甲'}]
    assert [w['code'] for w in warnings] == ['uncertain_field_boundary']


def test_unknown_column_bounds_warning_is_exposed():
    source = document([item('活动', 'detail', body='正文')])
    source['warnings'] = [{'code': 'unknown_column_bounds', 'page': 2,
                           'message': 'Text column bounds are not established for every detail line.'}]
    _, _, warnings = project_document(source, 'issue.pdf')
    assert warnings == [{'filename': 'issue.pdf', 'code': 'unknown_column_bounds',
                         'message': 'Text column bounds are not established for every detail line.'}]


def test_duplicate_identity_fails_instead_of_order_based_salt():
    first = item('同名消息', urls=['https://example.org/a#part'])
    second = item('同名消息', urls=['https://example.org/a#part'])
    second['category'] = '活动'
    with pytest.raises(BuildError) as exc:
        project([first, second])
    assert exc.value.code == 'ambiguous_identity'


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
    assert json.loads(before)['schema_version'] == 2
    (inputs / 'c.pdf').write_bytes(b'two')
    with patch('nannaweb.catalog.parse_pdf', side_effect=parse):
        with pytest.raises(BuildError, match='issue metadata'):
            build(inputs, output, cache)
    assert output.read_bytes() == before


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


def test_old_cache_is_not_used(tmp_path):
    inputs = tmp_path / 'input'
    inputs.mkdir()
    (inputs / 'a.pdf').write_bytes(b'one')
    cache = tmp_path / 'cache'
    old = cache / '2.14.4-reader-1' / hashlib.sha256(b'one').hexdigest()
    old.mkdir(parents=True)
    (old / 'document.json').write_text('{}')
    parsed = document([item('活动')], digest=hashlib.sha256(b'one').hexdigest())
    with patch('nannaweb.catalog.parse_pdf', return_value=parsed) as parser:
        build(inputs, tmp_path / 'out.json', cache)
    assert parser.call_count == 1


def test_corrupt_current_cache_does_not_replace_output(tmp_path):
    inputs = tmp_path / 'input'
    inputs.mkdir()
    (inputs / 'a.pdf').write_bytes(b'one')
    output = tmp_path / 'catalog.json'
    output.write_text('old')
    cache = tmp_path / 'cache'
    bundle = cache / '2.14.4-reader-2' / hashlib.sha256(b'one').hexdigest()
    bundle.mkdir(parents=True)
    (bundle / 'document.json').write_text('{}')
    with pytest.raises(BuildError, match='cached parser bundle'):
        build(inputs, output, cache)
    assert output.read_text() == 'old'


def test_fullwidth_clock_is_a_value_not_a_new_field_label():
    lines = visual(('活动时间：周五', 40), ('下午18：30-20：00', 80), ('地点：大厅', 50), ('次日9:30另有安排', 60))
    body = '\n'.join(line['text'] for line in lines)
    entries, warnings = project([item('活动', 'detail', body=body, lines=lines)])
    assert entries[0]['detail']['fields'] == [
        {'label': '活动时间', 'value': '周五 下午18：30-20：00'},
        {'label': '地点', 'value': '大厅'},
    ]
    assert entries[0]['detail']['text'] == body
    assert not warnings


def test_instruction_uri_colon_does_not_create_a_fake_label():
    lines = visual(('地点：大厅', 50), ('请填写问卷（https://example.org/form）', 100))
    body = '\n'.join(line['text'] for line in lines)
    entries, _ = project([item('活动', 'detail', body=body, lines=lines, other=['https://example.org/form'])])
    assert entries[0]['detail']['fields'] == [{'label': '地点', 'value': '大厅'}]
    assert entries[0]['detail']['text'] == body
    assert entries[0]['detail']['other_urls'] == ['https://example.org/form']


def test_short_line_can_complete_a_quoted_field_without_swallowing_note():
    lines = visual(('提交方式：加入“通知', 50), ('群”', 20), ('面向在校读者', 50))
    entries, warnings = project([item('消息', 'detail', body='\n'.join(x['text'] for x in lines), lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '提交方式', 'value': '加入“通知群”'}]
    assert '面向在校读者' in entries[0]['detail']['text']
    assert not warnings


def test_quote_interrupted_by_source_footer_is_not_a_complete_scalar():
    lines = visual(('提交方式：加入“通知', 100), ('详见：https://example.org/a', 90), ('群”', 20))
    body = '\n'.join(x['text'] for x in lines)
    entries, warnings = project([item('消息', 'detail', body=body, lines=lines)])
    assert entries[0]['detail']['fields'] == []
    assert entries[0]['detail']['text'] == body
    assert [warning['code'] for warning in warnings] == ['uncertain_field_boundary']


def test_complete_field_at_wrap_edge_does_not_swallow_prose_instruction():
    lines = visual(('活动地点：某校区报告厅', 100), ('扫码填写问卷领取纪念品', 50))
    body = '\n'.join(line['text'] for line in lines)
    entries, warnings = project([item('消息', 'detail', body=body, lines=lines)])
    assert entries[0]['detail']['fields'] == [{'label': '活动地点', 'value': '某校区报告厅'}]
    assert entries[0]['detail']['text'] == body
    assert not warnings
