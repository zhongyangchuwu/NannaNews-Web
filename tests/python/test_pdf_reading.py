from collections import defaultdict
import sys

import pytest

from nannaweb.common import source_url
import nannaweb.pdf_adapter as adapter
import nannaweb.pdf_text as pdf_text
from nannaweb.pdf_adapter import _line_in_column, _normalize, _table_items, _units
from nannaweb.pdf_text import TextAlignmentError, align_pages, column_bounds, lines


def fragment(text, x, y, width, mcid, height=10):
    return {'text': text, 'x': x, 'y': y, 'width': width, 'height': height, 'mcid': mcid}


def node(kind, mcids=(), children=(), annotations=(), **extra):
    return {'type': kind, 'marked_content_ids': list(mcids), 'children': list(children),
            'annotations': list(annotations), **extra}


def link(uri, x, y, width=40):
    return {'uri': uri, 'rect': {'x': x, 'y': y, 'width': width, 'height': 10}}


def test_physical_order_inside_semantic_node():
    index = {1: [fragment('前', 0, 10, 10, 1), fragment('后', 30, 10, 10, 1)],
             2: [fragment('链接', 10, 11, 20, 2)]}
    paragraph = node('P', [1], [node('Link', [2])])
    page = {'structure_tree': {'roots': [paragraph]}}
    assert list(_units(page, index))[0]['text'] == '前链接后'
    result = lines(index[1] + index[2], 3, 7)
    assert len(result) == 1
    assert (result[0]['page'], result[0]['paragraph'], result[0]['text']) == (3, 7, '前链接后')


def test_native_glyphs_follow_geometry_and_do_not_cross_cells(tmp_path):
    xml = tmp_path / 'native.xml'
    xml.write_text('''<pdf2xml><page number="1" width="100" height="100">
      <text left="0" top="10" width="30" height="10">“甲”</text>
      <text left="50" top="10" width="30" height="10">乙—丙</text>
    </page></pdf2xml>''', encoding='utf-8')
    page = {'page': 1, 'width': 100, 'height': 100,
            'text_items': [fragment('"甲"', 0, 10, 30, 1), fragment('乙-丙', 50, 10, 30, 2)],
            'structure_tree': {'roots': [node('P', [1]), node('P', [2])]}}
    index = align_pages({'pages': [page]}, xml)[0]
    assert index[1][0]['text'] == '“甲”'
    assert index[2][0]['text'] == '乙—丙'
    page['text_items'][1]['x'] = 0
    with pytest.raises(TextAlignmentError):
        align_pages({'pages': [page]}, xml)


def test_merged_native_run_stays_within_semantic_cell(tmp_path):
    xml = tmp_path / 'native.xml'
    xml.write_text('''<pdf2xml><page number="1" width="100" height="100">
      <text left="0" top="10" width="40" height="10">甲“乙”</text>
    </page></pdf2xml>''', encoding='utf-8')
    fragments = [fragment('甲', 0, 10, 20, 1), fragment('"乙"', 20, 10, 20, 2)]
    page = {'page': 1, 'width': 100.6, 'height': 100.2, 'text_items': fragments,
            'structure_tree': {'roots': [node('Table', children=[node('TR', children=[
                node('TD', [1], [node('Link', [2])])])])]}}
    index = align_pages({'pages': [page]}, xml)[0]
    assert sum(len(runs) for runs in index.values()) == 1
    run = next(iter(index.values()))[0]
    assert run['text'] == '甲“乙”' and run['x'] == 0 and run['width'] == 40
    page['structure_tree']['roots'] = [node('Table', children=[node('TR', children=[
        node('TD', [1]), node('TD', [2])])])]
    with pytest.raises(TextAlignmentError):
        align_pages({'pages': [page]}, xml)


def test_column_bounds_require_template_width_and_origin():
    page = {'width': 1327.68, 'text_items': [fragment('示例', 64.8, 10, 20, 1)]}
    bounds = column_bounds(page)
    assert len(bounds) == 1
    assert bounds[0][0] == pytest.approx(64.8)
    assert bounds[0][1] == pytest.approx(328.3776)
    page['text_items'][0]['x'] = 100
    assert column_bounds(page) == []
    page['width'] = 1300
    assert column_bounds(page) == []


def test_literal_urls_and_title_cell_ownership():
    title_url = 'https://example.invalid/#/apply?x=1'
    backlink = 'https://example.invalid'
    assert source_url(title_url) == title_url
    assert source_url(backlink) == backlink
    assert source_url('https://user:secret@example.invalid/') is None
    items = [fragment('活动', 0, 0, 20, 1), fragment('刊载日期', 60, 0, 40, 2),
             fragment('示例', 0, 20, 20, 3), fragment('10-12', 60, 20, 40, 4)]
    index = defaultdict(list)
    for item in items:
        index[item['mcid']].append(item)
    table = node('Table', children=[node('TR', children=[node('TH', [1]), node('TH', [2])]),
                                    node('TR', children=[node('TD', [3]), node('TD', [4])])])
    page = {'page': 1, 'text_items': items, 'annotations': [link(title_url, 0, 20, 20), link(backlink, 60, 20)]}
    rows, _ = _table_items({'node': table, 'path': [0], 'text': ''}, page, index, '活动', [])
    assert rows[0]['primary_urls'] == [title_url]
    assert rows[0]['other_urls'] == [backlink]


def test_detail_distinguishes_final_source_from_supplement(tmp_path):
    supplemental = 'https://example.invalid/extra#part'
    primary = 'https://example.invalid/#/source'
    fragments = [fragment('2026-01-01 No. 7', 0, 0, 90, 1),
                 fragment('活动', 0, 20, 20, 2), fragment('示例标题', 0, 40, 40, 3),
                 fragment('补充链接', 0, 60, 40, 4), fragment('详见：', 0, 80, 30, 5),
                 fragment('原文', 30, 80, 20, 6)]
    index = defaultdict(list)
    for item in fragments:
        index[item['mcid']].append(item)
    roots = [node('P', [1]), node('H1', [2], title='活动'),
             node('H2', [3], title='示例标题'), node('P', [4, 5], [node('Link', [6])])]
    page = {'page': 1, 'width': 100, 'height': 100, 'text': 'evidence', 'text_items': fragments,
            'annotations': [link(supplemental, 0, 60), link(primary, 30, 80, 20)],
            'structure_tree': {'roots': roots}}
    payload = {'total_pages': 1, 'pages': [page], 'images': []}
    result = _normalize(payload, {'bytes': b'pdf', 'filename': 'invented.pdf'}, tmp_path, '2.14.4', [index])
    detail = result['items'][0]
    assert detail['body_text'] == '补充链接\n详见：原文'
    assert detail['primary_urls'] == [primary]
    assert detail['other_urls'] == [supplemental]
    assert [line['paragraph'] for line in detail['body_lines']] == [0, 0]


def test_hanging_punctuation_preserves_actual_column_edge():
    left, right = 64.8, 328.3776
    assert _line_in_column({'text': '（补充）', 'x': left - 6, 'width': 72, 'height': 12}, left, right)
    assert _line_in_column({'text': '完整内容、', 'x': left, 'width': right - left + 4.5, 'height': 12}, left, right)
    assert not _line_in_column({'text': '普通文字', 'x': left - 6, 'width': 72, 'height': 12}, left, right)
    assert not _line_in_column({'text': '（越界）', 'x': left - 12, 'width': 72, 'height': 12}, left, right)


def test_styled_banners_end_sections_and_reference_uses_full_width(tmp_path):
    entries = [fragment('2026-01-01 No. 7', 64.8, 0, 90, 1),
               fragment('活动', 64.8, 20, 20, 2), fragment('普通标题', 64.8, 40, 40, 3),
               fragment('参考消息', 64.8, 60, 48, 4),
               fragment('参考消息', 591.84, 90, 144, 5, 36),
               fragment('参考标题', 64.8, 140, 80, 6),
               fragment('参考正文', 64.8, 160, 1100, 7, 18),
               fragment('图片附页', 591.84, 200, 144, 8, 36),
               fragment('附页标题', 64.8, 250, 80, 9),
               fragment('附页正文', 64.8, 270, 80, 10)]
    for item in entries:
        item['font_size'] = 36 if item['mcid'] in (5, 8) else 12
        item['font_weight'] = 812 if item['mcid'] in (5, 8) else 400
    index = defaultdict(list)
    for item in entries:
        index[item['mcid']].append(item)
    roots = [node('P', [1]), node('H1', [2], title='活动'), node('H2', [3], title='普通标题'),
             node('P', [4]), node('P', [5]), node('H1', [6], title='参考标题'), node('P', [7]),
             node('P', [8]), node('H1', [9], title='附页标题'), node('P', [10])]
    page = {'page': 1, 'width': 1327.68, 'height': 400, 'text': 'evidence',
            'text_items': entries, 'annotations': [], 'structure_tree': {'roots': roots}}
    payload = {'total_pages': 1, 'pages': [page], 'images': []}
    result = _normalize(payload, {'bytes': b'pdf', 'filename': 'invented.pdf'}, tmp_path, '2.14.4', [index])
    assert [item['title'] for item in result['items']] == ['普通标题', '参考标题']
    ordinary, reference = result['items']
    assert ordinary['body_text'] == '参考消息'
    assert reference['category'] == '参考消息'
    assert reference['body_text'] == '参考正文'
    assert reference['body_lines'][0]['column_right'] == pytest.approx(1262.88)


def test_unowned_native_and_tagged_text_are_rejected(tmp_path):
    xml = tmp_path / 'native.xml'
    xml.write_text('<pdf2xml><page number="1" width="100" height="100">'
                   '<text left="0" top="0" width="10" height="10">甲</text>'
                   '<text left="70" top="70" width="10" height="10">乙</text>'
                   '</page></pdf2xml>', encoding='utf-8')
    page = {'page': 1, 'width': 100, 'height': 100, 'text_items': [fragment('甲', 0, 0, 10, 1)],
            'structure_tree': {'roots': [node('P', [1])]}}
    with pytest.raises(TextAlignmentError, match='no tagged owner'):
        align_pages({'pages': [page]}, xml)
    page['text_items'][0]['mcid'] = None
    with pytest.raises(TextAlignmentError, match='no supported semantic owner'):
        align_pages({'pages': [page]}, xml)
    page['text_items'][0]['mcid'] = 1
    page['structure_tree']['roots'] = [node('Div', [1], [node('P', [2])])]
    with pytest.raises(TextAlignmentError, match='unowned direct text'):
        align_pages({'pages': [page]}, xml)


def test_nested_lists_and_tables_are_rejected():
    for root in (node('L', children=[node('LI', children=[node('P', [1]), node('P', [2])])]),
                 node('P', [1], [node('Table', children=[node('TD', [2])])])):
        with pytest.raises(TextAlignmentError):
            pdf_text._owners({'structure_tree': {'roots': [root]}})
    wrapper = node('P', [1], [node('Div', children=[node('P', [2])])])
    owners = pdf_text._owners({'structure_tree': {'roots': [wrapper]}})
    assert owners[1] == owners[2]


def test_geometry_limits_are_enforced_before_band_expansion(tmp_path, monkeypatch):
    xml = tmp_path / 'native.xml'
    xml.write_text('<pdf2xml><page number="1" width="100" height="100">'
                   '<text left="0" top="0" width="10" height="10">甲</text>'
                   '</page></pdf2xml>', encoding='utf-8')
    page = {'page': 1, 'width': 100, 'height': 100, 'text_items': [fragment('甲', 0, 0, 10, 1)],
            'structure_tree': {'roots': [node('P', [1])]}}
    for height in (float('inf'), float('nan'), 10**12):
        page['height'] = height
        with pytest.raises(TextAlignmentError, match='dimensions'):
            align_pages({'pages': [page]}, xml)
    page['height'] = 100
    monkeypatch.setattr(pdf_text, 'MAX_RUN_BANDS', 1)
    page['text_items'][0]['height'] = 40
    with pytest.raises(TextAlignmentError, match='band limit'):
        align_pages({'pages': [page]}, xml)
    page['text_items'][0]['height'] = 10
    monkeypatch.setattr(pdf_text, 'MAX_TOTAL_BANDS', 1)
    with pytest.raises(TextAlignmentError, match='band limit'):
        align_pages({'pages': [page]}, xml)


def test_cross_column_paragraph_is_rejected():
    fragments = [fragment('甲', 64.8, 10, 24, 1), fragment('乙', 376.3008, 10, 24, 2)]
    page = {'page': 1, 'width': 1327.68, 'text_items': fragments,
            'structure_tree': {'roots': [node('P', [1, 2])]}}
    with pytest.raises(adapter.PdfAdapterError, match='independent text columns'):
        list(_units(page, {1: [fragments[0]], 2: [fragments[1]]}))


def test_tied_annotation_requires_tagged_link_ownership():
    annotation = link('https://example.invalid/#route', 0, 10, 40)
    first = node('P', [1])
    second = node('P', [2])
    page = {'annotations': [annotation], 'structure_tree': {'roots': [first, second]}}
    index = {1: [fragment('甲', 0, 10, 20, 1)], 2: [fragment('乙', 20, 10, 20, 2)]}
    with pytest.raises(adapter.PdfAdapterError, match='multiple independent text owners'):
        adapter._annotations(first, page, index)
    first['children'] = [node('Link', annotations=[annotation])]
    assert adapter._annotations(first, page, index) == [annotation]
    assert adapter._annotations(second, page, index) == []


@pytest.mark.parametrize('action,code', [
    ("open('oversize', 'wb').write(b'x' * 100)", 'output_too_large'),
    ("os.symlink('missing', 'escape')", 'unsafe_asset_path'),
])
def test_monitor_survives_closed_output_pipes(tmp_path, monkeypatch, action, code):
    monkeypatch.setattr(adapter, 'MAX_ARTIFACT_BYTES', 32)
    monkeypatch.setattr(adapter, 'MAX_ASSET_BYTES', 0)
    monkeypatch.setattr(adapter, 'MAX_SOURCE_BYTES', 0)
    script = "import os,time; os.close(1); os.close(2); time.sleep(.15); " + action + "; time.sleep(.3)"
    with pytest.raises(adapter.PdfAdapterError) as error:
        adapter._run([sys.executable, '-c', script], tmp_path, timeout=2, monitor=True)
    assert error.value.code == code


def test_closed_output_pipes_do_not_disable_timeout(tmp_path):
    script = 'import os,time; os.close(1); os.close(2); time.sleep(2)'
    with pytest.raises(adapter.PdfAdapterError) as error:
        adapter._run([sys.executable, '-c', script], tmp_path, timeout=.2, monitor=True)
    assert error.value.code == 'parser_timeout'


@pytest.mark.parametrize('second_y', [10, 40])
def test_partial_grid_does_not_establish_other_paragraph_columns(second_y):
    fragments = [fragment('栏目甲', 64.8, 0, 24, 1), fragment('栏目乙', 376.3008, 0, 24, 2),
                 fragment('上段', 700, 10, 24, 3), fragment('下段', 1010, second_y, 24, 4)]
    page = {'page': 1, 'width': 1327.68, 'text_items': fragments,
            'structure_tree': {'roots': [node('P', [1]), node('P', [2]), node('P', [3, 4])]}}
    index = {item['mcid']: [item] for item in fragments}
    with pytest.raises(adapter.PdfAdapterError) as error:
        list(_units(page, index))
    assert error.value.code == 'unsupported_layout'
