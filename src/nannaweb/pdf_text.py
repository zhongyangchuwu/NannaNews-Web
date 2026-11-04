"""Geometry-scoped reconstruction of tagged text from local Poppler XML."""
from collections import defaultdict
import math
import xml.etree.ElementTree as ET

MAX_PAGE_DIMENSION = 100000
MAX_RUN_BANDS = 256
MAX_TOTAL_BANDS = 2000000


def valid_page_geometry(page):
    return all(isinstance(page.get(key), (int, float)) and math.isfinite(page[key])
               and 0 < page[key] <= MAX_PAGE_DIMENSION for key in ('width', 'height'))


def _bands(box, budget):
    first = int(box['y'] // 32)
    last = int((box['y'] + box['height']) // 32)
    count = last - first + 1
    if count > MAX_RUN_BANDS or budget[0] + count > MAX_TOTAL_BANDS:
        raise TextAlignmentError('Native text geometry exceeds the band limit')
    budget[0] += count
    return range(first, last + 1)


class TextAlignmentError(ValueError):
    """The native text layer cannot be aligned unambiguously to tagged text."""


def _overlap(a, b):
    return (max(0, min(a['x'] + a['width'], b['x'] + b['width']) - max(a['x'], b['x'])) *
            max(0, min(a['y'] + a['height'], b['y'] + b['height']) - max(a['y'], b['y'])))

def _owners(page):
    """Use rendered units as owners; table cells are always separate owners."""
    owners = {}

    def assign(node, owner):
        for mcid in node.get('marked_content_ids', []):
            if mcid in owners and owners[mcid] != owner:
                raise TextAlignmentError('Tagged text belongs to multiple semantic owners')
            owners[mcid] = owner
        for child in node.get('children', []):
            if child['type'] in ('L', 'Table', 'TD', 'TH'):
                raise TextAlignmentError('Nested lists or tables are unsupported')
            assign(child, owner)

    def visit(node, path):
        kind = node['type']
        if kind == 'L':
            raise TextAlignmentError('Composite lists are unsupported')
        if kind in ('TD', 'TH', 'P', 'Caption', 'Figure', 'L') or (
                len(kind) == 2 and kind[0] == 'H' and kind[1] in '123456') or (
                node.get('marked_content_ids') and not node.get('children')):
            assign(node, path)
        else:
            if node.get('marked_content_ids'):
                raise TextAlignmentError('Container has unowned direct text')
            for number, child in enumerate(node.get('children', [])):
                visit(child, path + (number,))

    for number, root in enumerate((page.get('structure_tree') or {}).get('roots', [])):
        visit(root, (number,))
    return owners


def align_pages(payload, xml_path):
    """Assign native runs to LiteParse MCIDs, never transferring text between pages."""
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError as error:
        raise TextAlignmentError('Native XML is malformed') from error
    native_pages = root.findall('page')
    if len(native_pages) != len(payload['pages']):
        raise TextAlignmentError('Native and tagged page counts differ')
    indexes = []
    for page, native_page in zip(payload['pages'], native_pages):
        if not valid_page_geometry(page):
            raise TextAlignmentError('PDF page dimensions exceed the geometry limit')
        if int(native_page.attrib['number']) != page['page']:
            raise TextAlignmentError('Native page numbering differs')
        # Poppler rounds page metadata, not the individual coordinates.
        native_size = {key: float(native_page.attrib[key]) for key in ('width', 'height')}
        if (not valid_page_geometry(native_size) or
                any(abs(page[key] - native_size[key]) > 1 for key in ('width', 'height'))):
            raise TextAlignmentError('Native page dimensions differ')
        owners = _owners(page)
        fragments = [f for f in page.get('text_items', []) if f.get('text', '').strip()]
        if any(f.get('mcid') is None or f['mcid'] not in owners for f in fragments):
            raise TextAlignmentError('Text has no supported semantic owner')
        index = defaultdict(list)
        matched = set()
        bins = defaultdict(list)
        budget = [0]
        for number, fragment in enumerate(fragments):
            if not all(isinstance(fragment.get(key), (int, float)) for key in ('x', 'y', 'width', 'height')):
                raise TextAlignmentError('Tagged text has invalid geometry')
            if (not all(math.isfinite(fragment[key]) for key in ('x', 'y', 'width', 'height'))
                    or fragment['height'] <= 0 or fragment['width'] <= 0
                    or fragment['y'] < -page['height'] or fragment['y'] + fragment['height'] > 2 * page['height']):
                raise TextAlignmentError('Tagged text has invalid geometry')
            for band in _bands(fragment, budget):
                bins[band].append(number)
        for element in native_page.findall('text'):
            text = ''.join(element.itertext())
            if not text.strip():
                continue
            run = {'text': text, 'x': float(element.attrib['left']),
                   'y': float(element.attrib['top']),
                   'width': float(element.attrib['width']),
                   'height': float(element.attrib['height'])}
            if (not all(math.isfinite(run[key]) for key in ('x', 'y', 'width', 'height'))
                    or run['width'] <= 0 or run['height'] <= 0
                    or run['y'] < -page['height'] or run['y'] + run['height'] > 2 * page['height']):
                raise TextAlignmentError('Native text has invalid geometry')
            candidates = []
            nearby = set()
            for band in _bands(run, budget):
                nearby.update(bins[band])
            for number in nearby:
                fragment = fragments[number]
                area = _overlap(run, fragment)
                if area:
                    candidates.append((area, number, fragment))
            if not candidates:
                raise TextAlignmentError('Native text has no tagged owner')
            candidates.sort(key=lambda value: value[0], reverse=True)
            best, _, owner = candidates[0]
            owner_key = owners.get(owner['mcid'], ('mcid', owner['mcid']))
            # Different MCIDs may be font runs of one paragraph or cell.
            # Separate cells/paragraphs remain separate semantic owners.
            if any(owners.get(fragment['mcid'], ('mcid', fragment['mcid'])) != owner_key
                   and area >= best * 0.8 for area, _, fragment in candidates[1:]):
                raise TextAlignmentError('Native text overlaps multiple tagged owners')
            index[owner['mcid']].append(run)
            for area, number, fragment in candidates:
                if owners.get(fragment['mcid'], ('mcid', fragment['mcid'])) == owner_key and area >= best * 0.2:
                    matched.add(number)
        # A node may have multiple native font runs for one tagged fragment.
        # Missing tagged text is an error, not permission to use normalized glyphs.
        if any(number not in matched for number in range(len(fragments))):
            raise TextAlignmentError('Tagged text has no matching native glyphs')
        indexes.append(index)
    return indexes


def column_bounds(page):
    """Return only grid columns supported by both template width and text origins."""
    width = page['width']
    columns = round((width / 72 - 9) / 4.72) + 2
    if not 2 <= columns <= 12 or abs(width - (9 + (columns - 2) * 4.72) * 72) > 0.5:
        return []
    margin = 0.9 * 72
    content_width = width - 2 * margin
    gutter = content_width * 0.04
    column_width = (content_width - (columns - 1) * gutter) / columns
    origins = [fragment.get('x') for fragment in page.get('text_items', [])
               if isinstance(fragment.get('x'), (int, float))]
    result = []
    for column in range(columns):
        left = margin + column * (column_width + gutter)
        if any(abs(x - left) <= 1 for x in origins):
            result.append((left, left + column_width))
    return result


def lines(fragments, page, paragraph):
    """Reconstruct visual lines within one semantic node, not across a page."""
    groups = []
    for fragment in sorted(fragments, key=lambda f: (f['y'] + f['height'] / 2, f['x'])):
        center = fragment['y'] + fragment['height'] / 2
        group = next((g for g in groups if abs(center - g['center']) <=
                      min(fragment['height'], g['height']) * 0.5), None)
        if group is None:
            group = {'center': center, 'height': fragment['height'], 'fragments': []}
            groups.append(group)
        group['fragments'].append(fragment)
    result = []
    for group in sorted(groups, key=lambda g: g['center']):
        runs = sorted(group['fragments'], key=lambda f: f['x'])
        parts = []
        previous = None
        for run in runs:
            if previous is not None and run['x'] - (previous['x'] + previous['width']) > 2:
                parts.append(' ')
            parts.append(run['text'])
            previous = run
        x = min(run['x'] for run in runs)
        y = min(run['y'] for run in runs)
        right = max(run['x'] + run['width'] for run in runs)
        bottom = max(run['y'] + run['height'] for run in runs)
        result.append({'text': ''.join(parts).strip(), 'x': x, 'y': y,
                       'width': right - x, 'height': bottom - y,
                       'page': page, 'paragraph': paragraph})
    return result
