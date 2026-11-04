import type { BulletinCatalog, BulletinDetail, BulletinEntry, BulletinIssue, BulletinListing } from './types';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => string(value) && value.trim().length > 0;
const urls = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const sourceKeys = {
  catalog: { schema_version: true, issues: true, entries: true, warnings: true },
  issue: { id: true, date: true, number: true, title: true, filename: true, sha256: true },
  entry: { id: true, issue_id: true, category: true, listings: true, detail: true },
  listing: { title: true, cutoff: true, cutoff_raw: true, listed_on: true, listed_raw: true, source_urls: true, page: true },
  detail: { title: true, text: true, fields: true, source_urls: true, other_urls: true, page: true },
  field: { label: true, value: true },
  warning: { filename: true, code: true, message: true },
} satisfies Record<string, Record<string, true>>;
type SourceShape = keyof typeof sourceKeys;
const sourceKeyCounts = Object.fromEntries(Object.entries(sourceKeys)
  .map(([shape, fields]) => [shape, Object.keys(fields).length])) as Record<SourceShape, number>;

function keys(value: Record<string, unknown>, shape: SourceShape): boolean {
  const actual = Object.keys(value);
  return actual.length === sourceKeyCounts[shape] && actual.every(key => Object.hasOwn(sourceKeys[shape], key));
}

function date(value: unknown): value is string {
  if (!string(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function listing(value: unknown): value is BulletinListing {
  return record(value) && keys(value, 'listing') && nonempty(value.title) &&
    (value.cutoff === null || date(value.cutoff)) && string(value.cutoff_raw) &&
    (value.listed_on === null || date(value.listed_on)) && string(value.listed_raw) &&
    urls(value.source_urls) && Number.isInteger(value.page) && (value.page as number) > 0;
}

function detail(value: unknown): value is BulletinDetail {
  return record(value) && keys(value, 'detail') && nonempty(value.title) && string(value.text) &&
    Array.isArray(value.fields) && value.fields.every(field => record(field) && keys(field, 'field') &&
      nonempty(field.label) && nonempty(field.value)) && urls(value.source_urls) && urls(value.other_urls) &&
    Number.isInteger(value.page) && (value.page as number) > 0;
}

/** The catalog only contains explicitly projected source facts, never parser receipts. */
export function parseCatalog(value: unknown): BulletinCatalog {
  if (!record(value) || value.schema_version !== 2) throw new Error('数据版本无效，请重新导入 PDF');
  if (!keys(value, 'catalog') || !Array.isArray(value.issues) || !Array.isArray(value.entries) || !Array.isArray(value.warnings)) {
    throw new Error('数据格式无效');
  }
  const issueIds = new Set<string>();
  for (const issue of value.issues) {
    if (!record(issue) || !keys(issue, 'issue') || !nonempty(issue.id) || issueIds.has(issue.id) || !date(issue.date) ||
        !Number.isInteger(issue.number) || (issue.number as number) <= 0 || !nonempty(issue.title) ||
        !nonempty(issue.filename) || /[\\/]/.test(issue.filename) || !string(issue.sha256) || !/^[a-f0-9]{64}$/.test(issue.sha256)) {
      throw new Error('期刊数据格式无效');
    }
    issueIds.add(issue.id);
  }
  const entriesByIssue = new Map<string, Set<string>>();
  for (const entry of value.entries) {
    if (!record(entry) || !keys(entry, 'entry') || !nonempty(entry.id) || !string(entry.issue_id) || !issueIds.has(entry.issue_id) ||
        !string(entry.category) || !Array.isArray(entry.listings) || !entry.listings.every(listing) ||
        !(entry.detail === null || detail(entry.detail)) || (!entry.listings.length && entry.detail === null)) {
      throw new Error('消息数据格式无效');
    }
    const seen = entriesByIssue.get(entry.issue_id) ?? new Set<string>();
    if (seen.has(entry.id)) throw new Error('同一期存在重复消息标识');
    seen.add(entry.id);
    entriesByIssue.set(entry.issue_id, seen);
  }
  for (const warning of value.warnings) {
    if (!record(warning) || !keys(warning, 'warning') || !string(warning.filename) || !string(warning.code) || !string(warning.message)) {
      throw new Error('提示数据格式无效');
    }
  }
  return value as unknown as BulletinCatalog;
}

export function sortedIssues(issues: BulletinIssue[]): BulletinIssue[] {
  return [...issues].sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number || a.id.localeCompare(b.id));
}

export function beijingToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function entryTitle(entry: BulletinEntry): string {
  return entry.listings[0]?.title ?? entry.detail?.title ?? '';
}

/** Last clear list cutoff; uncertain rows must not be masked by clear ones. */
export function entryCutoff(entry: BulletinEntry): string | null {
  let latest: string | null = null;
  for (const row of entry.listings) {
    if (row.cutoff === null) return null;
    if (latest === null || row.cutoff > latest) latest = row.cutoff;
  }
  return latest;
}

export function entrySourceUrls(entry: BulletinEntry): string[] {
  return [...new Set([...entry.listings.flatMap(row => row.source_urls), ...(entry.detail?.source_urls ?? [])])];
}

export function dailyGroups(entries: BulletinEntry[], issueId: string, today: string) {
  const current: BulletinEntry[] = [];
  const unknown: BulletinEntry[] = [];
  const notices: BulletinEntry[] = [];
  for (const entry of entries) {
    if (entry.issue_id !== issueId) continue;
    if (!entry.listings.length) {
      notices.push(entry);
      continue;
    }
    const cutoff = entryCutoff(entry);
    if (cutoff === null) unknown.push(entry);
    else if (cutoff >= today) current.push(entry);
  }
  current.sort((left, right) => entryCutoff(left)!.localeCompare(entryCutoff(right)!));
  return { current, unknown, notices };
}

/** Newest occurrence wins when searching across issues or showing favorites. */
export function latestEntries(catalog: BulletinCatalog): BulletinEntry[] {
  const order = new Map(sortedIssues(catalog.issues).map((issue, index) => [issue.id, index]));
  const seen = new Set<string>();
  return [...catalog.entries].sort((a, b) => (order.get(a.issue_id) ?? Infinity) - (order.get(b.issue_id) ?? Infinity))
    .filter(entry => !seen.has(entry.id) && !!seen.add(entry.id));
}

export function historyEntries(catalog: BulletinCatalog, issueId: string, query = '', category = ''): BulletinEntry[] {
  const entries = filterEntries(issueId === 'all' ? catalog.entries : catalog.entries.filter(entry => entry.issue_id === issueId), query, category);
  return issueId === 'all' ? latestEntries({ ...catalog, entries }) : entries;
}

export function filterEntries(entries: BulletinEntry[], query: string, category: string): BulletinEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(entry => (!category || entry.category === category) &&
    (!needle || [entry.category, ...entry.listings.map(row => row.title), entry.detail?.title ?? '', entry.detail?.text ?? '']
      .some(text => text.toLocaleLowerCase().includes(needle))));
}

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        host === 'nik-nul.github.io' ||
        (host === 'zhongyangchuwu.github.io' && /^\/nannanews(?:\/|$)/.test(path)) ||
        (host === 'github.com' && /^\/nik-nul\/nannanews(?:\/|$)/.test(path))) return null;
    return value;
  } catch {
    return null;
  }
}
