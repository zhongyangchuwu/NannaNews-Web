import type { BulletinCatalog, BulletinEntry, BulletinIssue } from './types';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const nullableString = (value: unknown): boolean => value === null || string(value);

function date(value: unknown): value is string {
  if (!string(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Reject malformed catalogs instead of presenting partial or invented content. */
export function parseCatalog(value: unknown): BulletinCatalog {
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.issues) ||
      !Array.isArray(value.entries) || !Array.isArray(value.warnings)) throw new Error('数据格式无效');
  const ids = new Set<string>();
  for (const issue of value.issues) {
    if (!record(issue) || !string(issue.id) || !issue.id || ids.has(issue.id) || !date(issue.date) ||
        !Number.isInteger(issue.number) || !string(issue.title) || !string(issue.filename) || !string(issue.sha256)) {
      throw new Error('期刊数据格式无效');
    }
    ids.add(issue.id);
  }
  for (const entry of value.entries) {
    if (!record(entry) || !string(entry.id) || !entry.id || !string(entry.issue_id) || !ids.has(entry.issue_id) ||
        !string(entry.title) || !string(entry.category) || (entry.kind !== 'activity' && entry.kind !== 'notice') ||
        !(entry.cutoff === null || date(entry.cutoff)) || !string(entry.cutoff_raw) ||
        !(entry.listed_on === null || date(entry.listed_on)) || !nullableString(entry.time) ||
        !nullableString(entry.location) || !string(entry.summary) || !string(entry.text) ||
        !Array.isArray(entry.source_urls) || !entry.source_urls.every(string) ||
        !Number.isInteger(entry.page) || (entry.page as number) < 1) {
      throw new Error('消息数据格式无效');
    }
  }
  for (const warning of value.warnings) {
    if (!record(warning) || !string(warning.filename) || !string(warning.code) || !string(warning.message)) {
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

export function dailyGroups(entries: BulletinEntry[], issueId: string, today: string) {
  const current: BulletinEntry[] = [];
  const unknown: BulletinEntry[] = [];
  const notices: BulletinEntry[] = [];
  for (const entry of entries) {
    if (entry.issue_id !== issueId) continue;
    if (entry.cutoff !== null) {
      if (entry.cutoff >= today) current.push(entry);
    } else if (entry.kind === 'notice') notices.push(entry);
    else unknown.push(entry);
  }
  current.sort((left, right) => left.cutoff!.localeCompare(right.cutoff!));
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
    (!needle || [entry.title, entry.summary, entry.text, entry.category].some(text => text.toLocaleLowerCase().includes(needle))));
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
    return url.href;
  } catch {
    return null;
  }
}
