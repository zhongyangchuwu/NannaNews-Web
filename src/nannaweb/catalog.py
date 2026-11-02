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
from urllib.parse import urlsplit

from .common import FULL_DATE, source_url
from .pdf_adapter import PARSER_VERSION, PdfAdapterError, parse_pdf

# Version normalized parser evidence when adapter behavior changes.
CACHE_FORMAT = 'reader-1'


class BuildError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _title_key(value):
    return ''.join(unicodedata.normalize('NFKC', value).casefold().split())


def _strong_urls(item):
    result = set()
    for value in item.get('source_urls', []):
        url = source_url(value)
        if not url:
            continue
        parts = urlsplit(url)
        # A link to a prior bulletin identifies an issue, not an article.
        if parts.hostname == 'nik-nul.github.io' and (parts.path == '/news' or parts.path.startswith('/news/')):
            continue
        if parts.path == '/' and not parts.query:
            continue
        result.add(url)
    return result


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


def _identity(item, listed, issue_id, ordinal):
    key = _title_key(item['title'])
    urls = sorted(_strong_urls(item))
    # Listed date and title are the stable cross-issue key. A source URL
    # disambiguates independently sourced messages with identical titles.
    if listed:
        parts = [listed, key, urls[0] if urls else '']
    elif urls:
        parts = [key, urls[0]]
    else:
        parts = [issue_id, key, str(ordinal)]
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]


def _field(text, labels):
    match = re.search(r'(?:^|\n)\s*(?:' + labels + r')\s*[：:]\s*', text)
    if not match:
        return None
    tail = text[match.end():]
    boundary = r'(?:报名截止时间|材料提交截止时间|报名截止|投稿截止|截止时间|截止日期|(?:活动|演出|开课|比赛|讲座|参访|服务|报名|投稿|招募|参赛|参与)?(?:时间|时段|地点|对象|方式|内容|人数|费用)|主讲人|主持人|嘉宾|面向人群|线上参与方式|详见)'
    stop = re.search(r'\n\s*' + boundary + r'\s*[：:]|\n\s*\n', tail)
    value = tail[:stop.start()] if stop else tail
    value = re.sub(r'(?<=[\u3400-\u9fff])\s*\n\s*(?=[\u3400-\u9fff])', '', value)
    return ' '.join(value.split()) or None


def _summary(text):
    paragraph = text.strip().split('\n\n', 1)[0]
    if re.match(r'[^\n：:]{1,24}[：:]', paragraph):
        return ''
    value = ' '.join(paragraph.split())
    return value if len(value) <= 180 else value[:180] + '…'


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
    warnings = []
    summaries = []
    details = []
    for item in items:
        if not isinstance(item, dict) or item.get('kind') not in ('summary', 'detail', 'notice') or not isinstance(item.get('title'), str) or not item['title'].strip() or not isinstance(item.get('body_text'), str) or not isinstance(item.get('locator'), dict) or not isinstance(item['locator'].get('page'), int) or item['locator']['page'] < 1:
            raise BuildError('invalid_structure', 'The PDF contains invalid extracted item evidence.')
        (summaries if item['kind'] == 'summary' else details).append(item)

    # Combine repeated table rows only where their title and source evidence
    # do not contradict each other. Preserve all original rows in the text.
    groups = []
    for item in summaries:
        listed = [d.get('raw_text', '').strip() for d in item.get('dates', []) if d.get('kind') == 'listed']
        candidates = []
        for group in groups:
            prior_dates = [[d.get('raw_text', '').strip() for d in prior.get('dates', []) if d.get('kind') == 'listed'] for prior in group]
            sources = _strong_urls(item)
            prior_sources = [_strong_urls(prior) for prior in group]
            if (_title_key(group[0]['title']) == _title_key(item['title'])
                    and all(not listed or not prior or listed == prior for prior in prior_dates)
                    and all(not sources or not prior or not sources.isdisjoint(prior) for prior in prior_sources)):
                candidates.append(group)
        if len(candidates) == 1:
            candidates[0].append(item)
        else:
            groups.append([item])
    title_counts = Counter(_title_key(g[0]['title']) for g in groups)
    detail_title_counts = Counter(_title_key(d['title']) for d in details)
    url_counts = Counter(u for g in groups for u in set().union(*(_strong_urls(x) for x in g)))
    detail_url_counts = Counter(u for d in details for u in _strong_urls(d))
    matches = {}
    for di, detail in enumerate(details):
        key = _title_key(detail['title'])
        candidates = []
        for gi, group in enumerate(groups):
            group_urls = set().union(*(_strong_urls(x) for x in group))
            shared = group_urls & _strong_urls(detail)
            title_match = key == _title_key(group[0]['title']) and title_counts[key] == 1 and detail_title_counts[key] == 1 and not (group_urls and _strong_urls(detail) and not shared)
            url_match = any(url_counts[u] == 1 and detail_url_counts[u] == 1 for u in shared)
            if title_match or url_match:
                candidates.append(gi)
        if len(candidates) == 1:
            matches.setdefault(candidates[0], []).append(di)
    used = set()
    entries = []
    for group_index, group in enumerate(groups):
        chosen = matches.get(group_index, [])
        detail = details[chosen[0]] if len(chosen) == 1 else None
        if detail is not None:
            used.add(chosen[0])
        dates = [d for row in group for d in row.get('dates', []) if d.get('kind') == 'deadline']
        listed_dates = [d for row in group for d in row.get('dates', []) if d.get('kind') == 'listed']
        raw = '\n'.join(str(d.get('raw_text', '')).strip() for d in dates)
        normalized_cutoffs = [_date(d.get('raw_text'), issue_date, True) for d in dates]
        complete_cutoffs = all(any(d.get('kind') == 'deadline' for d in row.get('dates', [])) for row in group)
        cutoff = max(normalized_cutoffs) if normalized_cutoffs and complete_cutoffs and all(value is not None for value in normalized_cutoffs) else None
        listed = _date(listed_dates[0].get('raw_text'), issue_date, False) if listed_dates else None
        for field, value, present in [('cutoff', cutoff, bool(dates)), ('listed_on', listed, bool(listed_dates))]:
            if present and value is None:
                warnings.append({'filename': filename, 'code': 'unresolved_' + field, 'message': 'An invalid or ambiguous table date was retained as text.'})
        evidence = '\n\n'.join(row['body_text'] for row in group)
        if detail:
            evidence += '\n\n' + detail['body_text']
        all_items = group + ([detail] if detail else [])
        strong = set().union(*(_strong_urls(item) for item in all_items))
        urls = list(dict.fromkeys(url for item in all_items for value in item.get('source_urls', []) if (url := source_url(value)) in strong))
        entries.append({'id': _identity(group[0], listed, issue_id, group_index), 'issue_id': issue_id, 'title': group[0]['title'], 'category': group[0].get('category') or (detail.get('category') if detail else None) or '', 'kind': 'activity', 'cutoff': cutoff, 'cutoff_raw': raw, 'listed_on': listed, 'time': _field(detail['body_text'], '(?:活动|演出|开课|比赛|讲座|参访|服务)?时间') if detail else None, 'location': _field(detail['body_text'], '(?:活动|演出|比赛|讲座|参访|服务)?地点') if detail else None, 'summary': _summary(detail['body_text']) if detail else '', 'text': evidence, 'source_urls': urls, 'page': detail['locator']['page'] if detail else group[0]['locator']['page']})
    for index, item in enumerate(details):
        if index in used:
            continue
        body = item['body_text']
        strong = _strong_urls(item)
        urls = list(dict.fromkeys(url for value in item.get('source_urls', []) if (url := source_url(value)) in strong))
        entries.append({'id': _identity(item, None, issue_id, index), 'issue_id': issue_id, 'title': item['title'], 'category': item.get('category') or '', 'kind': 'notice', 'cutoff': None, 'cutoff_raw': '', 'listed_on': None, 'time': _field(body, '(?:活动|演出|开课|比赛|讲座|参访|服务)?时间'), 'location': _field(body, '(?:活动|演出|比赛|讲座|参访|服务)?地点'), 'summary': _summary(body), 'text': body, 'source_urls': urls, 'page': item['locator']['page']})
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
    catalog = {'schema_version': 1, 'issues': issues, 'entries': entries, 'warnings': warnings}
    _atomic_json(output, catalog)
    return {'issues': len(issues), 'entries': len(entries), 'warnings': len(warnings), 'duplicate_pdfs': len(files) - len(seen)}
