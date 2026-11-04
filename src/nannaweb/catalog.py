"""Import immutable PDF source facts into the local canonical catalog."""
from collections import Counter, defaultdict
from datetime import date
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
import uuid
import unicodedata

from .common import FULL_DATE, source_url
from .pdf_adapter import PARSER_VERSION, PdfAdapterError, parse_pdf


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



def _empty_catalog():
    return {'schema_version': 3, 'issues': [], 'activities': [], 'listings': [],
            'details': [], 'publications': [], 'identity_aliases': [], 'warnings': []}


def _invalid(message):
    raise BuildError('invalid_catalog', message)


def _validate_catalog(catalog):
    """Reject malformed masters before using any of their facts as authority."""
    root = _empty_catalog()
    if not isinstance(catalog, dict) or set(catalog) != set(root) or type(catalog['schema_version']) is not int or catalog['schema_version'] != 3:
        _invalid('The canonical catalog has an invalid schema.')
    if any(not isinstance(catalog[k], list) for k in root if k != 'schema_version'):
        _invalid('The canonical catalog arrays are invalid.')

    def record(value, keys):
        if not isinstance(value, dict) or set(value) != set(keys.split()):
            _invalid('A canonical catalog record has invalid keys.')

    def string(value, nonempty=False):
        if not isinstance(value, str) or (nonempty and not value.strip()):
            _invalid('A canonical catalog string is invalid.')

    def iso(value):
        try:
            if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                raise ValueError
        except ValueError:
            _invalid('A canonical catalog date is invalid.')

    def positive(value):
        if type(value) is not int or value <= 0:
            _invalid('A canonical catalog number is invalid.')

    def urls(value):
        if not isinstance(value, list) or any(not isinstance(url, str) for url in value):
            _invalid('A canonical catalog URL is invalid.')

    issues, activities, sources = {}, set(), {}
    issue_keys, hashes = set(), set()
    for issue in catalog['issues']:
        record(issue, 'id date number title filename sha256 extraction_version')
        for key in ('id', 'title'):
            string(issue[key])
        for key in ('filename', 'extraction_version'):
            string(issue[key], True)
        iso(issue['date'])
        positive(issue['number'])
        if (Path(issue['filename']).name != issue['filename'] or not isinstance(issue['sha256'], str)
                or not re.fullmatch(r'[0-9a-f]{64}', issue['sha256']) or issue['id'] in issues
                or (issue['date'], issue['number']) in issue_keys or issue['sha256'] in hashes):
            _invalid('The canonical catalog has duplicate or invalid issues.')
        issues[issue['id']] = issue
        issue_keys.add((issue['date'], issue['number'])); hashes.add(issue['sha256'])
    for activity in catalog['activities']:
        record(activity, 'id')
        string(activity['id'], True)
        if activity['id'] in activities:
            _invalid('The canonical catalog has duplicate activities.')
        activities.add(activity['id'])
    orders = set()
    for kind in ('listings', 'details'):
        for source in catalog[kind]:
            record(source, ('id issue_id category order title cutoff cutoff_raw listed_on listed_raw source_urls page'
                            if kind == 'listings' else
                            'id issue_id category order title text fields source_urls other_urls page'))
            for key in ('id', 'issue_id', 'category'):
                string(source[key])
            string(source['title'], True)
            positive(source['page'])
            if type(source['order']) is not int or source['order'] < 0:
                _invalid('A canonical source order is invalid.')
            if (kind, source['id']) in sources or source['issue_id'] not in issues or (source['issue_id'], source['order']) in orders:
                _invalid('A canonical source has a duplicate identity, order, or invalid issue.')
            sources[(kind, source['id'])] = source['issue_id']
            orders.add((source['issue_id'], source['order']))
            urls(source['source_urls'])
            if kind == 'listings':
                for key in ('cutoff_raw', 'listed_raw'):
                    string(source[key])
                for key in ('cutoff', 'listed_on'):
                    if source[key] is not None:
                        iso(source[key])
            else:
                string(source['text']); urls(source['other_urls'])
                if not isinstance(source['fields'], list):
                    _invalid('A canonical detail field list is invalid.')
                for field in source['fields']:
                    record(field, 'label value')
                    string(field['label'], True); string(field['value'], True)
    refs, pairs, used_activities = set(), set(), set()
    for publication in catalog['publications']:
        record(publication, 'activity_id issue_id listing_ids detail_id')
        aid, iid = publication['activity_id'], publication['issue_id']
        if not isinstance(aid, str) or not isinstance(iid, str) or aid not in activities or iid not in issues or (aid, iid) in pairs:
            _invalid('A canonical publication has an invalid activity or issue.')
        pairs.add((aid, iid)); used_activities.add(aid)
        listing_ids, detail_id = publication['listing_ids'], publication['detail_id']
        if not isinstance(listing_ids, list) or (detail_id is not None and not isinstance(detail_id, str)):
            _invalid('A canonical publication has invalid source references.')
        linked = [(sid, 'listings') for sid in listing_ids] + ([(detail_id, 'details')] if detail_id is not None else [])
        if not linked:
            _invalid('A canonical publication has no source.')
        for sid, kind in linked:
            if not isinstance(sid, str) or (kind, sid) in refs or sources.get((kind, sid)) != iid:
                _invalid('A canonical source is missing, repeated, or belongs to another issue.')
            refs.add((kind, sid))
    if refs != set(sources) or used_activities != activities or {iid for _, iid in pairs} != set(issues):
        _invalid('The canonical catalog has unreferenced issues, sources, or activities.')
    aliases = set()
    for alias in catalog['identity_aliases']:
        record(alias, 'legacy_id activity_id')
        string(alias['legacy_id']); string(alias['activity_id'], True)
        if (alias['legacy_id'] in aliases or alias['activity_id'] not in activities
                or (alias['legacy_id'] in activities and alias['legacy_id'] != alias['activity_id'])):
            _invalid('A canonical identity alias is ambiguous or invalid.')
        aliases.add(alias['legacy_id'])
    for warning in catalog['warnings']:
        record(warning, 'filename code message')
        for key in warning:
            string(warning[key])


def _sources(document, filename, digest):
    try:
        issue_date = date.fromisoformat(document['issue_date'])
        number, title, items = document['issue_number'], document['title'], document['items']
        if (type(number) is not int or number <= 0 or not isinstance(title, str) or not title.strip()
                or not isinstance(items, list) or not items or document['source_sha256'] != digest
                or document['schema_version'] != 1 or document['parser']['version'] != PARSER_VERSION
                or document['parser']['text_layer'] != 'poppler-xml-1'):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise BuildError('invalid_issue', 'The PDF has invalid issue or extraction metadata.') from None
    unsupported = {'unsupported_layout', 'unsupported_table', 'unsupported_table_row', 'unresolved_table_title'}
    if any(w.get('code') in unsupported for w in document.get('warnings', [])):
        raise BuildError('unsupported_layout', 'The PDF has unsupported or incomplete structural extraction.')
    version = PARSER_VERSION + '-poppler-xml-1-canonical-3'
    iid = f'{issue_date.isoformat()}-{number}'
    issue = {'id': iid, 'date': issue_date.isoformat(), 'number': number, 'title': title,
             'filename': filename, 'sha256': digest, 'extraction_version': version}
    warnings = [{'filename': filename, 'code': w['code'], 'message': w['message']}
                for w in document.get('warnings', []) if w.get('code') == 'unknown_column_bounds']
    listings, details, keys = [], [], set()
    for order, item in enumerate(items):
        try:
            key = item['local_key']
            if (not isinstance(key, str) or not key.strip() or key in keys
                    or item['kind'] not in ('summary', 'detail', 'notice')
                    or not isinstance(item['title'], str) or not item['title'].strip()
                    or not isinstance(item['body_text'], str) or not isinstance(item.get('category') or '', str)
                    or type(item['locator']['page']) is not int or item['locator']['page'] < 1):
                raise ValueError
            keys.add(key)
            sid = hashlib.sha256(json.dumps([digest, version, key], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            base = {'id': sid, 'issue_id': iid, 'category': item.get('category') or '', 'order': order}
            if item['kind'] == 'summary':
                listings.append({**base, **_listing(item, issue_date, filename, warnings)})
            else:
                details.append({**base, **_detail(item, filename, warnings)})
        except (KeyError, TypeError, ValueError, AttributeError):
            raise BuildError('invalid_structure', 'The PDF contains invalid extracted source evidence.') from None
    return issue, listings, details, warnings


def _groups(listings, details):
    groups = []
    for row in listings:
        candidates = [g for g in groups if all(
            _title_key(row['title']) == _title_key(other['title'])
            and _categories_match(row['category'], other['category'])
            and row['listed_on'] == other['listed_on']
            and bool(row['source_urls'])
            and set(row['source_urls']) == set(other['source_urls']) for other in g['listings'])]
        if len(candidates) == 1:
            candidates[0]['listings'].append(row)
        else:
            groups.append({'listings': [row], 'detail': None})
    # Multiple possible bodies can represent separate sessions, not duplicates.
    split_groups = []
    for group in groups:
        row = group['listings'][0]
        possible = [detail for detail in details
                    if _categories_match(row['category'], detail['category'])
                    and _title_match(row['title'], detail['title'],
                                     set(row['source_urls']) & set(detail['source_urls']))
                    and (not row['source_urls'] or not detail['source_urls']
                         or set(row['source_urls']) & set(detail['source_urls']))]
        if len(possible) > 1:
            split_groups.extend({'listings': [item], 'detail': None} for item in group['listings'])
        else:
            split_groups.append(group)
    groups = split_groups
    group_urls = [set().union(*(set(row['source_urls']) for row in g['listings'])) for g in groups]
    group_counts = Counter(url for urls in group_urls for url in urls)
    detail_counts = Counter(url for d in details for url in set(d['source_urls']))
    edges = []
    for gi, group in enumerate(groups):
        row = group['listings'][0]
        for di, detail in enumerate(details):
            shared = group_urls[gi] & set(detail['source_urls'])
            if not _categories_match(row['category'], detail['category']) or (group_urls[gi] and detail['source_urls'] and not shared):
                continue
            exact = _title_key(row['title']) == _title_key(detail['title'])
            unique = any(group_counts[url] == detail_counts[url] == 1 for url in shared)
            contained = _title_match(row['title'], detail['title'], shared)
            if exact or contained or unique:
                edges.append((gi, di, 3 if exact else 2 if contained else 1))
    used = set()
    for gi, di, score in edges:
        if (score == max(s for g, _, s in edges if g == gi) == max(s for _, d, s in edges if d == di)
                and sum(g == gi and s == score for g, _, s in edges) == 1
                and sum(d == di and s == score for _, d, s in edges) == 1):
            groups[gi]['detail'] = details[di]
            used.add(di)
    groups.extend({'listings': [], 'detail': detail} for di, detail in enumerate(details) if di not in used)
    return groups


def _associate(catalog, issue, listings, details):
    groups = _groups(listings, details)
    source_map = {(kind, s['id']): s for kind in ('listings', 'details') for s in catalog[kind]}
    issues = {i['id']: i for i in catalog['issues']}
    new_urls = Counter(url for group in groups for url in set(
        url for source in group['listings'] + ([group['detail']] if group['detail'] else [])
        for url in source['source_urls']))
    old_urls = defaultdict(set)
    for publication in catalog['publications']:
        linked = [('listings', sid) for sid in publication['listing_ids']]
        if publication['detail_id']:
            linked.append(('details', publication['detail_id']))
        for kind, sid in linked:
            for url in source_map[(kind, sid)]['source_urls']:
                old_urls[(publication['issue_id'], url)].add(publication['activity_id'])
    edges = {}
    for gi, group in enumerate(groups):
        new_sources = group['listings'] + ([group['detail']] if group['detail'] else [])
        for publication in catalog['publications']:
            old_issue = issues[publication['issue_id']]
            old_sources = [source_map[('listings', sid)] for sid in publication['listing_ids']]
            if publication['detail_id']:
                old_sources.append(source_map[('details', publication['detail_id'])])
            new_dates = {row['listed_on'] for row in group['listings'] if row['listed_on'] is not None}
            old_dates = {source['listed_on'] for source in old_sources
                         if 'listed_on' in source and source['listed_on'] is not None}
            if new_dates and old_dates:
                if new_dates != old_dates:
                    continue
                origin = False
                continuity = True
            else:
                origin = (not old_dates and old_issue['date'] in new_dates
                          or not new_dates and issue['date'] in old_dates)
                continuity = origin
            if not continuity:
                continue
            new_links = {url for source in new_sources for url in source['source_urls']}
            old_links = {url for source in old_sources for url in source['source_urls']}
            if new_links and old_links and new_links.isdisjoint(old_links):
                continue
            for new in new_sources:
                for old in old_sources:
                    # Continuity belongs to the whole publication, so a sibling
                    # detail cannot bypass contradictory listing origins.
                    new_source_links, old_source_links = set(new['source_urls']), set(old['source_urls'])
                    shared = new_source_links & old_source_links
                    if ((new_source_links and old_source_links and not shared)
                            or not _categories_match(new['category'], old['category'])):
                        continue
                    new_title, old_title = _title_key(new['title']), _title_key(old['title'])
                    reliable = any(new_urls[url] == 1 and len(old_urls[(publication['issue_id'], url)]) == 1 for url in shared)
                    if new_title == old_title:
                        score = 3
                    elif _title_match(new['title'], old['title'], shared):
                        score = 2
                    elif origin and reliable and len(os.path.commonprefix((new_title, old_title))) >= 4:
                        score = 1
                    else:
                        continue
                    key = (gi, publication['activity_id'])
                    edges[key] = max(edges.get(key, 0), score)
    for gi, group in enumerate(groups):
        group_edges = [(aid, score) for (index, aid), score in edges.items() if index == gi]
        aid = None
        if group_edges:
            best = max(score for _, score in group_edges)
            winners = [candidate for candidate, score in group_edges if score == best]
            if len(winners) == 1:
                candidate = winners[0]
                competing = [score for (index, other), score in edges.items() if other == candidate and index != gi]
                if not competing or best > max(competing):
                    aid = candidate
        if aid is None:
            aid = uuid.uuid4().hex
            catalog['activities'].append({'id': aid})
        catalog['publications'].append({'activity_id': aid, 'issue_id': issue['id'],
                                        'listing_ids': [s['id'] for s in group['listings']],
                                        'detail_id': group['detail']['id'] if group['detail'] else None})


def _migrate(catalog, path):
    try:
        legacy = json.loads(Path(path).read_text(encoding='utf-8'))
        if not isinstance(legacy, dict) or legacy.get('schema_version') != 2 or not isinstance(legacy.get('issues'), list) or not isinstance(legacy.get('entries'), list):
            raise ValueError
        issue_hashes = {issue['id']: issue['sha256'] for issue in legacy['issues']}
        if (len(issue_hashes) != len(legacy['issues'])
                or any(not isinstance(iid, str) or not iid or not isinstance(digest, str)
                       or not re.fullmatch(r'[0-9a-f]{64}', digest) for iid, digest in issue_hashes.items())):
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError):
        raise BuildError('invalid_legacy_catalog', 'The legacy identity catalog is invalid or unavailable.') from None
    issues = {issue['sha256']: issue['id'] for issue in catalog['issues']}
    sources = {(kind, s['id']): s for kind in ('listings', 'details') for s in catalog[kind]}
    publications = defaultdict(list)
    for publication in catalog['publications']:
        publications[publication['issue_id']].append(publication)
    matches = defaultdict(set)
    unresolved = set()
    for entry in legacy['entries']:
        try:
            lid, old_iid = entry['id'], entry['issue_id']
            if not isinstance(lid, str) or not lid or old_iid not in issue_hashes or not isinstance(entry['listings'], list):
                raise ValueError
            evidence = [('listings', old) for old in entry['listings']]
            if entry['detail'] is not None:
                evidence.append(('details', entry['detail']))
            if not evidence:
                raise ValueError
            for kind, old in evidence:
                if not isinstance(old, dict):
                    raise ValueError
                strings = ('title', 'cutoff_raw', 'listed_raw') if kind == 'listings' else ('title', 'text')
                url_keys = ('source_urls',) if kind == 'listings' else ('source_urls', 'other_urls')
                if (any(not isinstance(old[key], str) for key in strings)
                        or any(not isinstance(old[key], list) or any(not isinstance(url, str) for url in old[key]) for key in url_keys)
                        or type(old['page']) is not int or old['page'] <= 0):
                    raise ValueError
                if kind == 'listings':
                    for key in ('cutoff', 'listed_on'):
                        if old[key] is not None and (not isinstance(old[key], str) or date.fromisoformat(old[key]).isoformat() != old[key]):
                            raise ValueError
                elif (not isinstance(old['fields'], list)
                      or any(not isinstance(field, dict) or not isinstance(field.get('label'), str)
                             or not isinstance(field.get('value'), str) for field in old['fields'])):
                    raise ValueError
            iid = issues.get(issue_hashes[old_iid])
            if iid is None:
                unresolved.add(lid); continue
            resolved = set()
            for kind, old in evidence:
                candidates = set()
                keys = (('title', 'text', 'source_urls', 'other_urls', 'page') if kind == 'details' else
                        ('title', 'cutoff', 'cutoff_raw', 'listed_on', 'listed_raw', 'source_urls', 'page'))
                for publication in publications[iid]:
                    ids = publication['listing_ids'] if kind == 'listings' else ([publication['detail_id']] if publication['detail_id'] else [])
                    if any(all(old[key] == sources[(kind, sid)][key] for key in keys) for sid in ids):
                        candidates.add(publication['activity_id'])
                if len(candidates) != 1:
                    unresolved.add(lid)
                else:
                    resolved.update(candidates)
            if len(resolved) != 1:
                unresolved.add(lid)
            matches[lid].update(resolved)
        except (KeyError, TypeError, ValueError):
            raise BuildError('invalid_legacy_catalog', 'The legacy identity catalog has invalid entries.') from None
    existing = {a['legacy_id']: a['activity_id'] for a in catalog['identity_aliases']}
    canonical = {a['id'] for a in catalog['activities']}
    added = 0
    for lid in unresolved | {lid for lid, candidates in matches.items() if len(candidates) != 1}:
        if lid in existing:
            raise BuildError('ambiguous_legacy_identity', 'New legacy evidence makes an existing identity alias ambiguous.')
        unresolved.add(lid)
    for lid, candidates in matches.items():
        if lid in unresolved:
            continue
        aid = next(iter(candidates))
        if lid in existing and existing[lid] != aid:
            raise BuildError('ambiguous_legacy_identity', 'New legacy evidence contradicts an existing identity alias.')
        if lid in canonical and lid != aid:
            unresolved.add(lid); continue
        if lid not in existing:
            catalog['identity_aliases'].append({'legacy_id': lid, 'activity_id': aid})
            added += 1
    return added, len(unresolved)


def import_pdfs(input_dir, catalog, cache, legacy_catalog=None):
    input_dir, catalog, cache = map(Path, (input_dir, catalog, cache))
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
    files.sort(key=lambda path: path.name)
    if not files:
        raise BuildError('empty_input', 'The input directory contains no PDF files.')
    catalog.parent.mkdir(parents=True, exist_ok=True)
    with (catalog.parent / (catalog.name + '.lock')).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BuildError('catalog_locked', 'Another import is updating this catalog.') from None
        try:
            master = json.loads(catalog.read_text(encoding='utf-8')) if catalog.exists() else _empty_catalog()
        except (ValueError, UnicodeError):
            raise BuildError('invalid_catalog', 'The canonical catalog is not valid JSON.') from None
        _validate_catalog(master)
        accepted = {issue['sha256'] for issue in master['issues']}
        seen, added = set(), 0
        for path in files:
            with path.open('rb') as handle:
                digest = hashlib.file_digest(handle, 'sha256').hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            if digest in accepted:
                continue
            # Never promote a pre-existing reader-2 bundle: first acceptance is fresh.
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='.nannaweb-', dir=cache) as workdir:
                try:
                    document = parse_pdf(path, workdir)
                except PdfAdapterError as exc:
                    raise BuildError(exc.code, str(exc)) from None
                issue, listings, details, warnings = _sources(document, path.name, digest)
            if any((old['date'], old['number']) == (issue['date'], issue['number']) for old in master['issues']):
                raise BuildError('duplicate_issue', 'Different PDF bytes have contradictory or duplicate issue metadata.')
            _associate(master, issue, listings, details)
            master['issues'].append(issue)
            master['listings'].extend(listings)
            master['details'].extend(details)
            master['warnings'].extend(warnings)
            accepted.add(digest)
            added += 1
        aliases, unresolved = _migrate(master, legacy_catalog) if legacy_catalog is not None else (0, 0)
        _validate_catalog(master)
        if added or aliases or not catalog.exists():
            _atomic_json(catalog, master)
        return {'issues_added': added, 'duplicate_pdfs': len(files) - len(seen),
                'aliases_added': aliases, 'unresolved_legacy_ids': unresolved}
