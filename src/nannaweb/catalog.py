"""Project local tagged-PDF evidence into the static reader contract."""
from collections import Counter
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

from .common import FULL_DATE, source_url
from .pdf_adapter import PARSER_VERSION, PdfAdapterError, parse_pdf

# Version normalized parser evidence when adapter behavior changes.
CACHE_FORMAT = 'reader-2'


class BuildError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _title_key(value):
    value = unicodedata.normalize('NFKC', value).casefold()
    value = value.translate(str.maketrans('“”‘’—–‐‑−', '\"\"\'\'-----'))
    return re.sub(r'-+', '-', ''.join(value.split()))


def _literal_urls(item, role):
    return list(dict.fromkeys(value for value in item.get(role, []) if source_url(value)))


def _strong_urls(item):
    # Identity uses the validated literal URI, including any fragment. Display
    # URLs remain separate from this comparison set.
    return set(_literal_urls(item, 'primary_urls'))


def _date(raw, issue, forward):
    raw = str(raw or '').strip()
    full = FULL_DATE.fullmatch(raw)
    partial = re.fullmatch(r'(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})(?:日|号)?', raw)
    try:
        if full:
            return date(*map(int, full.groups())).isoformat()
        if not partial:
            return None
        month, day = map(int, partial.groups())
        year = issue.year
        # Only a clear year-boundary transition supplies a different year.
        # A deadline yesterday stays expired, not silently valid for a year.
        if forward and issue.month - month >= 6:
            year += 1
        elif not forward and month - issue.month >= 6:
            year -= 1
        candidate = date(year, month, day)
        if not forward and candidate > issue:
            return None
        return candidate.isoformat()
    except ValueError:
        return None


def _identity(item, listed, issue_id, ordinal, urls=None):
    key = _title_key(item['title'])
    sources = sorted(_strong_urls(item) if urls is None else urls)
    if listed:
        parts = [listed, key, sources[0] if sources else '']
    elif sources:
        parts = [key, sources[0]]
    else:
        parts = [issue_id, key, str(ordinal)]
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]


_LABEL = re.compile(r'^\s*([\w\u3400-\u9fff（）()·、/ -]{0,23}[\u3400-\u9fffA-Za-z）)])\s*[：:]\s*(.*)$')
_CLOCK = re.compile(r'^[^\d：:\n]{0,8}\d{1,2}[：:]\d{2}(?:\s*[-–—~至]\s*\d{1,2}[：:]\d{2})?')
_DATE_LINE = re.compile(r'^(?:\d{4}\s*[-/.年]\s*)?\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}')
_URI = re.compile(r'(?:https?://|mailto:)', re.I)
_FIELD_DELIMITERS = (('（', '）'), ('(', ')'), ('【', '】'), ('[', ']'), ('“', '”'))


def _unfinished_field(value):
    return (any(value.count(left) > value.count(right) for left, right in _FIELD_DELIMITERS)
            or value.rstrip().endswith(('并', '以及')))


def _fields(item, filename, warnings):
    lines = item.get('body_lines') or []
    # In the absence of geometry, do not guess that an unlabelled physical
    # line belongs to the preceding field.
    if not lines:
        lines = [{'text': text} for text in item['body_text'].splitlines()]
    # Only an independently established column boundary can prove that a
    # line reaches the wrap edge; the longest line in a field cannot.
    result = []
    current = None
    previous = None
    uncertain = False

    def finish():
        nonlocal current, uncertain
        if current and current['value'] and not uncertain and not _unfinished_field(current['value']):
            result.append(current)
        elif current and (uncertain or _unfinished_field(current['value'])):
            warnings.append({'filename': filename, 'code': 'uncertain_field_boundary',
                             'message': f"A field boundary could not be determined for {current['label']}; its text was retained."})
        current = None
        uncertain = False

    for line in lines:
        text = str(line.get('text', '')).strip()
        if not text:
            finish()
            previous = None
            continue
        if _URI.match(text):
            finish()
            previous = line
            continue
        same_paragraph = (previous is not None and line.get('paragraph') is not None
                          and line.get('paragraph') == previous.get('paragraph')
                          and line.get('page') == previous.get('page'))
        right = previous.get('column_right') if previous else None
        known_boundary = (same_paragraph and isinstance(right, (int, float))
                          and line.get('column_right') == right
                          and isinstance(previous.get('x'), (int, float))
                          and isinstance(previous.get('width'), (int, float))
                          and isinstance(previous.get('height'), (int, float)))
        # One point covers rounding differences between PDF glyph boxes and
        # the independently established column edge.
        wrapped = (known_boundary and
                   previous['x'] + previous['width'] >= right - previous['height'] - 1)
        closes_open = (current and known_boundary
                       and isinstance(previous.get('y'), (int, float))
                       and isinstance(line.get('x'), (int, float))
                       and isinstance(line.get('y'), (int, float))
                       and 0 < line['y'] - previous['y'] <= 2 * previous['height']
                       and abs(line['x'] - previous['x']) <= previous['height']
                       and any(current['value'].count(left) > current['value'].count(right)
                               and text.count(right) > text.count(left)
                               for left, right in _FIELD_DELIMITERS))
        match = None if _CLOCK.match(text) else _LABEL.match(text)
        if match and match.group(1).strip() == '详见':
            # The final link block has its own URL roles and remains in text.
            finish()
            break
        if current and same_paragraph and _unfinished_field(current['value']) and match:
            if wrapped or closes_open:
                current['value'] += text
            else:
                uncertain = True
                finish()
            previous = line
            continue
        uri = _URI.search(text)
        if match and uri and uri.start() < match.start(2):
            # A sentence ending in a URI scheme is not a label/value pair.
            finish()
            previous = line
            continue
        if match:
            finish()
            current = {'label': match.group(1).strip(), 'value': match.group(2).strip()}
        elif current:
            temporal = any(word in current['label'] for word in ('时间', '日期', '时段', '截止', '日程'))
            clock = same_paragraph and temporal and bool(_CLOCK.match(text) or _DATE_LINE.match(text))
            clearly_prose = bool(re.match(r'^(?:面向|请扫码|扫码|欢迎|敬请|更多|详情|感兴趣|有意|本活动|活动旨在)', text))
            if (closes_open or (not clearly_prose and (clock or wrapped))
                    or (wrapped and _unfinished_field(current['value']))):
                separator = ' ' if clock or not (re.search(r'[\u3400-\u9fff、，]$', current['value']) and re.match(r'[\u3400-\u9fff]', text)) else ''
                current['value'] += separator + text
            elif clearly_prose or not same_paragraph or known_boundary:
                finish()
            else:
                uncertain = True
        previous = line
    finish()
    return result


def _categories_match(left, right):
    return not left or not right or _title_key(left) == _title_key(right)


def _title_match(left, right, shared):
    a, b = _title_key(left), _title_key(right)
    return a == b or (bool(shared) and min(len(a), len(b)) >= 4 and (a in b or b in a))


def _detail(item, filename, warnings):
    return {'title': item['title'], 'text': item['body_text'],
            'fields': _fields(item, filename, warnings),
            'source_urls': _literal_urls(item, 'primary_urls'),
            'other_urls': _literal_urls(item, 'other_urls'),
            'page': item['locator']['page']}


def _listing(item, issue_date, filename, warnings):
    raw = {}
    for kind in ('deadline', 'listed'):
        values = [str(d.get('raw_text', '')).strip() for d in item.get('dates', []) if d.get('kind') == kind]
        raw[kind] = '\n'.join(values)
    cutoff = _date(raw['deadline'], issue_date, True) if raw['deadline'] else None
    listed = _date(raw['listed'], issue_date, False) if raw['listed'] else None
    for name, value, original in [('cutoff', cutoff, raw['deadline']), ('listed_on', listed, raw['listed'])]:
        if original and value is None:
            warnings.append({'filename': filename, 'code': 'unresolved_' + name,
                             'message': 'An invalid or ambiguous table date was retained as text.'})
    return {'title': item['title'], 'cutoff': cutoff, 'cutoff_raw': raw['deadline'],
            'listed_on': listed, 'listed_raw': raw['listed'],
            'source_urls': _literal_urls(item, 'primary_urls'), 'page': item['locator']['page']}


def project_document(document, filename):
    try:
        issue_date = date.fromisoformat(document['issue_date'])
        number = document['issue_number']
        title = document['title']
        digest = document['source_sha256']
        items = document['items']
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0 or not isinstance(title, str) or not title.strip() or not re.fullmatch(r'[0-9a-f]{64}', digest) or not isinstance(items, list):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise BuildError('invalid_issue', 'The PDF has missing or invalid issue metadata.') from None
    unsupported = {'unsupported_layout', 'unsupported_table', 'unsupported_table_row', 'unresolved_table_title'}
    if any(w.get('code') in unsupported for w in document.get('warnings', [])) or not items:
        raise BuildError('unsupported_layout', 'The PDF has unsupported or incomplete structural extraction.')
    issue_id = f'{issue_date.isoformat()}-{number}'
    issue = {'id': issue_id, 'date': issue_date.isoformat(), 'number': number, 'title': title, 'filename': filename, 'sha256': digest}
    warnings = [{'filename': filename, 'code': w['code'], 'message': w['message']}
                for w in document.get('warnings', []) if w.get('code') == 'unknown_column_bounds']
    summaries = []
    details = []
    for item in items:
        if not isinstance(item, dict) or item.get('kind') not in ('summary', 'detail', 'notice') or not isinstance(item.get('title'), str) or not item['title'].strip() or not isinstance(item.get('body_text'), str) or not isinstance(item.get('locator'), dict) or not isinstance(item['locator'].get('page'), int) or item['locator']['page'] < 1:
            raise BuildError('invalid_structure', 'The PDF contains invalid extracted item evidence.')
        (summaries if item['kind'] == 'summary' else details).append(item)

    # Group compatible repeated rows, but retain every original row.
    groups = []
    for item in summaries:
        listed = [d.get('raw_text', '').strip() for d in item.get('dates', []) if d.get('kind') == 'listed']
        sources = _strong_urls(item)
        candidates = []
        for group in groups:
            prior_dates = [[d.get('raw_text', '').strip() for d in prior.get('dates', []) if d.get('kind') == 'listed'] for prior in group]
            prior_sources = [_strong_urls(prior) for prior in group]
            if (_title_key(group[0]['title']) == _title_key(item['title'])
                    and all(_categories_match(item.get('category'), prior.get('category')) for prior in group)
                    and all(not listed or not prior or listed == prior for prior in prior_dates)
                    and all(not sources or not prior or not sources.isdisjoint(prior) for prior in prior_sources)):
                candidates.append(group)
        if len(candidates) == 1:
            candidates[0].append(item)
        else:
            groups.append([item])

    group_urls = [set().union(*(_strong_urls(row) for row in group)) for group in groups]
    group_url_counts = Counter(url for urls in group_urls for url in urls)
    detail_urls = [_strong_urls(detail) for detail in details]
    detail_url_counts = Counter(url for urls in detail_urls for url in urls)
    edges = []
    for di, detail in enumerate(details):
        urls = detail_urls[di]
        for gi, group in enumerate(groups):
            shared = group_urls[gi] & urls
            if (not _categories_match(group[0].get('category'), detail.get('category'))
                    or (group_urls[gi] and urls and not shared)):
                continue
            exact = _title_key(group[0]['title']) == _title_key(detail['title'])
            title_match = _title_match(group[0]['title'], detail['title'], shared)
            unique_source = any(group_url_counts[url] == 1 and detail_url_counts[url] == 1 for url in shared)
            if exact or title_match or unique_source:
                edges.append((gi, di, 3 if exact else 2 if title_match else 1))
    matches = {}
    for gi, di, score in edges:
        group_best = max(s for g, _, s in edges if g == gi)
        detail_best = max(s for _, d, s in edges if d == di)
        if (score == group_best == detail_best
                and sum(g == gi and s == score for g, _, s in edges) == 1
                and sum(d == di and s == score for _, d, s in edges) == 1):
            matches[gi] = di

    used = set(matches.values())
    entries = []
    ids = set()

    def add(entry):
        if entry['id'] in ids:
            raise BuildError('ambiguous_identity', 'Distinct extracted entries have the same identity.')
        ids.add(entry['id'])
        entries.append(entry)

    for group_index, group in enumerate(groups):
        listings = [_listing(row, issue_date, filename, warnings) for row in group]
        detail = details[matches[group_index]] if group_index in matches else None
        listed = next((row['listed_on'] for row in listings if row['listed_on']), None)
        add({'id': _identity(group[0], listed, issue_id, group_index, group_urls[group_index]),
             'issue_id': issue_id,
             'category': group[0].get('category') or (detail.get('category') if detail else None) or '',
             'listings': listings, 'detail': _detail(detail, filename, warnings) if detail else None})
    for index, item in enumerate(details):
        if index not in used:
            add({'id': _identity(item, None, issue_id, index), 'issue_id': issue_id,
                 'category': item.get('category') or '', 'listings': [],
                 'detail': _detail(item, filename, warnings)})
    return issue, entries, warnings


def _atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, prefix='.nannaweb-', delete=False) as handle:
            temp = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.replace(temp, path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def build(input_dir, output, cache):
    input_dir, output, cache = map(Path, (input_dir, output, cache))
    if input_dir.is_symlink() or not input_dir.is_dir():
        raise BuildError('invalid_input', 'The input directory is unavailable or is a symbolic link.')
    root = input_dir.resolve()
    files = []
    for path in input_dir.iterdir():
        if path.suffix.lower() != '.pdf':
            continue
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            raise BuildError('invalid_source', 'A PDF symbolic link escapes the input directory.')
        if path.is_file():
            files.append(path)
    files.sort(key=lambda p: p.name)
    if not files:
        raise BuildError('empty_input', 'The input directory contains no PDF files.')
    issues, entries, warnings, seen = [], [], [], set()
    dates, numbers = {}, {}
    for path in files:
        try:
            with path.open('rb') as handle:
                digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        except OSError:
            raise BuildError('invalid_source', 'A PDF source could not be read.') from None
        if digest in seen:
            continue
        seen.add(digest)
        bundle = cache / f'{PARSER_VERSION}-{CACHE_FORMAT}' / digest
        document_path = bundle / 'document.json'
        if bundle.exists():
            try:
                document = json.loads(document_path.read_text(encoding='utf-8'))
                if document.get('source_sha256') != digest or document.get('parser', {}).get('version') != PARSER_VERSION:
                    raise ValueError
            except (OSError, ValueError, TypeError, AttributeError):
                raise BuildError('invalid_cache', 'A cached parser bundle is invalid.') from None
        else:
            bundle.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='.nannaweb-', dir=bundle.parent) as workdir:
                try:
                    document = parse_pdf(path, workdir)
                except PdfAdapterError as exc:
                    raise BuildError(exc.code, str(exc)) from None
                if document.get('source_sha256') != digest:
                    raise BuildError('source_changed', 'A PDF changed while being extracted.')
                _atomic_json(Path(workdir) / 'document.json', document)
                os.replace(workdir, bundle)
        issue, issue_entries, issue_warnings = project_document(document, path.name)
        if issue['date'] in dates or issue['number'] in numbers:
            raise BuildError('duplicate_issue', 'Different PDF files have contradictory or duplicate issue metadata.')
        dates[issue['date']] = issue['id']
        numbers[issue['number']] = issue['id']
        issues.append(issue)
        entries.extend(issue_entries)
        warnings.extend(issue_warnings)
    issues.sort(key=lambda x: (x['date'], x['number']), reverse=True)
    catalog = {'schema_version': 2, 'issues': issues, 'entries': entries, 'warnings': warnings}
    _atomic_json(output, catalog)
    return {'issues': len(issues), 'entries': len(entries), 'warnings': len(warnings), 'duplicate_pdfs': len(files) - len(seen)}
