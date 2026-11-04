import type { BulletinCatalog, BulletinIssue, DetailSource as PrintedDetail, PublicationView } from './types';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const nonempty = (v: unknown): v is string => string(v) && v.trim().length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
const integer = (v: unknown, min: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const shapeKeys = {
  catalog: 'schema_version issues activities listings details publications identity_aliases warnings'.split(' '),
  issue: 'id date number title filename sha256 extraction_version'.split(' '),
  activity: ['id'],
  listing: 'id issue_id category order title cutoff cutoff_raw listed_on listed_raw source_urls page'.split(' '),
  detail: 'id issue_id category order title text fields source_urls other_urls page'.split(' '),
  field: ['label', 'value'],
  publication: 'activity_id issue_id listing_ids detail_id'.split(' '),
  alias: ['legacy_id', 'activity_id'],
  warning: ['filename', 'code', 'message'],
};
const keys = (v: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(v).length === expected.length && expected.every(name => Object.hasOwn(v, name));
function date(v: unknown): v is string {
  if (!string(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === v;
}

/** Validate the complete persisted graph before exposing any source facts. */
export function parseCatalog(value: unknown): BulletinCatalog {
  const fail = (): never => { throw new Error('数据格式或关联无效'); };
  if (!record(value) || value.schema_version !== 3 || !keys(value, shapeKeys.catalog) ||
      !Array.isArray(value.issues) || !Array.isArray(value.activities) || !Array.isArray(value.listings) ||
      !Array.isArray(value.details) || !Array.isArray(value.publications) || !Array.isArray(value.identity_aliases) || !Array.isArray(value.warnings)) return fail();
  const issues = new Set<string>();
  const materials = new Set<string>();
  const issuePairs = new Set<string>();
  for (const x of value.issues) {
    if (!record(x) || !keys(x, shapeKeys.issue) || !nonempty(x.id) || issues.has(x.id) ||
        !date(x.date) || !integer(x.number, 1) || !nonempty(x.title) || !nonempty(x.filename) || /[\\/]/.test(x.filename) || x.filename === '.' || x.filename === '..' ||
        !string(x.sha256) || !/^[a-f0-9]{64}$/.test(x.sha256) || materials.has(x.sha256) || !nonempty(x.extraction_version)) return fail();
    const pair = `${x.date}\0${x.number}`;
    if (issuePairs.has(pair)) return fail();
    issuePairs.add(pair);
    issues.add(x.id);
    materials.add(x.sha256);
  }
  const activities = new Set<string>();
  for (const x of value.activities) {
    if (!record(x) || !keys(x, shapeKeys.activity) || !nonempty(x.id) || activities.has(x.id)) return fail();
    activities.add(x.id);
  }
  const listings = new Map<string, string>();
  const details = new Map<string, string>();
  const orders = new Map<string, Set<number>>();
  for (const [items, target, isDetail] of [[value.listings, listings, false], [value.details, details, true]] as const) {
    for (const x of items) {
      if (!record(x) || !keys(x, isDetail ? shapeKeys.detail : shapeKeys.listing) ||
          !nonempty(x.id) || target.has(x.id) || !string(x.issue_id) || !issues.has(x.issue_id) || !string(x.category) || !integer(x.order, 0) ||
          !nonempty(x.title) || !strings(x.source_urls) || !integer(x.page, 1)) return fail();
      if (isDetail ? !string(x.text) || !strings(x.other_urls) || !Array.isArray(x.fields) || !x.fields.every((f: unknown) => record(f) && keys(f, shapeKeys.field) && nonempty(f.label) && nonempty(f.value)) :
          !(x.cutoff === null || date(x.cutoff)) || !string(x.cutoff_raw) || !(x.listed_on === null || date(x.listed_on)) || !string(x.listed_raw)) return fail();
      const used = orders.get(x.issue_id) ?? new Set<number>();
      if (used.has(x.order as number)) return fail();
      used.add(x.order as number); orders.set(x.issue_id, used); target.set(x.id, x.issue_id);
    }
  }
  const pairs = new Map<string, Set<string>>();
  const referencedListings = new Set<string>(); const referencedDetails = new Set<string>();
  for (const x of value.publications) {
    if (!record(x) || !keys(x, shapeKeys.publication) || !string(x.activity_id) || !activities.has(x.activity_id) ||
        !string(x.issue_id) || !issues.has(x.issue_id) || !strings(x.listing_ids) || !(x.detail_id === null || string(x.detail_id)) ||
        (!x.listing_ids.length && x.detail_id === null)) return fail();
    const seen = pairs.get(x.activity_id) ?? new Set<string>();
    if (seen.has(x.issue_id)) return fail();
    seen.add(x.issue_id); pairs.set(x.activity_id, seen);
    for (const id of x.listing_ids) {
      if (listings.get(id) !== x.issue_id || referencedListings.has(id)) return fail();
      referencedListings.add(id);
    }
    if (x.detail_id !== null) {
      if (details.get(x.detail_id) !== x.issue_id || referencedDetails.has(x.detail_id)) return fail();
      referencedDetails.add(x.detail_id);
    }
  }
  if (orders.size !== issues.size || pairs.size !== activities.size || referencedListings.size !== listings.size || referencedDetails.size !== details.size) return fail();
  const aliases = new Set<string>();
  for (const x of value.identity_aliases) {
    if (!record(x) || !keys(x, shapeKeys.alias) || !nonempty(x.legacy_id) || aliases.has(x.legacy_id) ||
        !string(x.activity_id) || !activities.has(x.activity_id) || (activities.has(x.legacy_id) && x.legacy_id !== x.activity_id)) return fail();
    aliases.add(x.legacy_id);
  }
  for (const x of value.warnings) if (!record(x) || !keys(x, shapeKeys.warning) || !string(x.filename) || !string(x.code) || !string(x.message)) return fail();
  return value as unknown as BulletinCatalog;
}

export function beijingToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function publicationViews(catalog: BulletinCatalog): PublicationView[] {
  const listings = new Map(catalog.listings.map(x => [x.id, x]));
  const details = new Map(catalog.details.map(x => [x.id, x]));
  return catalog.publications.map(publication => {
    const rows = publication.listing_ids.map(id => listings.get(id)!).sort((a, b) => a.order - b.order);
    const detail = publication.detail_id === null ? null : details.get(publication.detail_id)!;
    return { id: publication.activity_id, issue_id: publication.issue_id, category: rows[0]?.category ?? detail!.category, listings: rows, detail };
  }).sort((a, b) => (a.listings[0]?.order ?? a.detail!.order) - (b.listings[0]?.order ?? b.detail!.order));
}

/** Preserve selected priority, or restore individual row order for one original issue. */
export function listingGroups(entries: readonly PublicationView[], sourceOrder = false) {
  const rows = entries.flatMap(entry => entry.listings.map(row => ({ entry, row })));
  if (sourceOrder) rows.sort((a, b) => a.row.order - b.row.order);
  const groups: { category: string; rows: typeof rows }[] = [];
  for (const item of rows) {
    if (!groups.length || groups[groups.length - 1].category !== item.row.category) {
      groups.push({ category: item.row.category, rows: [] });
    }
    groups[groups.length - 1].rows.push(item);
  }
  return groups;
}
export function resolveIdentity(catalog: BulletinCatalog, id: string): string | null {
  if (catalog.activities.some(activity => activity.id === id)) return id;
  return catalog.identity_aliases.find(alias => alias.legacy_id === id)?.activity_id ?? null;
}
export function entryCutoff(entry: PublicationView): string | null {
  let last: string | null = null;
  for (const row of entry.listings) {
    if (row.cutoff === null) return null;
    if (last === null || row.cutoff > last) last = row.cutoff;
  }
  return last;
}
export interface DetailSource { issue: BulletinIssue; detail: PrintedDetail }
export function indexDetails(catalog: BulletinCatalog): Map<string, DetailSource[]> {
  const issues = new Map(catalog.issues.map(issue => [issue.id, issue]));
  const index = new Map<string, DetailSource[]>();
  for (const entry of publicationViews(catalog)) {
    if (!entry.detail) continue;
    const sources = index.get(entry.id) ?? [];
    sources.push({ issue: issues.get(entry.issue_id)!, detail: entry.detail }); index.set(entry.id, sources);
  }
  for (const sources of index.values()) sources.sort((a, b) => b.issue.date.localeCompare(a.issue.date) || b.issue.number - a.issue.number);
  return index;
}
export function resolveDetail(entry: PublicationView, issue: BulletinIssue | undefined, index: ReadonlyMap<string, readonly DetailSource[]>): DetailSource | null {
  if (!issue) return null;
  const sources = index.get(entry.id) ?? [];
  return sources.find(source => source.issue.id === entry.issue_id) ?? sources.find(source => source.issue.date < issue.date ||
    (source.issue.date === issue.date && source.issue.number <= issue.number)) ?? null;
}
export function filterEntries(entries: PublicationView[], query: string, category: string): PublicationView[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(entry => {
    const detail = entry.detail;
    return (!category || entry.category === category || entry.listings.some(row => row.category === category) || entry.detail?.category === category) &&
      (!needle || [entry.category, ...entry.listings.map(row => row.title), detail?.title ?? '', detail?.text ?? ''].some(text => text.toLocaleLowerCase().includes(needle)));
  });
}
export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value); const host = url.hostname.toLowerCase().replace(/\.+$/, ''); const path = decodeURIComponent(url.pathname).toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host === 'nik-nul.github.io' ||
        (host === 'zhongyangchuwu.github.io' && /^\/nannanews(?:\/|$)/.test(path)) ||
        (host === 'github.com' && /^\/nik-nul\/nannanews(?:\/|$)/.test(path))) return null;
    return value;
  } catch { return null; }
}
