import type { BulletinCatalog, BulletinIssue } from './types';
import { indexDetails, resolveIdentity } from './reader';
import { isCalendarDate } from './diary';

export interface ReaderLink { pathname: string; search: string }
export type DiarySection = 'new' | 'list';
interface Filters { q?: string; category?: string; open?: boolean }
interface DiaryOptions extends Filters { detail?: string; row?: string; back?: string; missing?: string }

export function diaryLink(date: string | null, view: DiarySection = 'new', options: DiaryOptions = {}): ReaderLink {
  const params = new URLSearchParams();
  if (date !== null) params.set('date', date);
  if (view === 'list') params.set('view', 'list');
  if (options.q) params.set('q', options.q);
  if (options.category) params.set('category', options.category);
  if (view === 'list' && options.open) params.set('open', '1');
  if (options.detail) params.set('detail', options.detail);
  if (options.row) params.set('row', options.row);
  if (options.back) params.set('back', options.back);
  if (options.missing) params.set('missing', options.missing);
  return { pathname: '/', search: params.size ? `?${params}` : '' };
}

export function activityLink(id: string | null, mode: 'activities' | 'current' | 'favorites' = 'activities', options: Filters & { status?: 'passed' | 'unknown'; back?: string } = {}): ReaderLink {
  const params = new URLSearchParams();
  if (id) params.set('activity', id);
  if (options.q) params.set('q', options.q);
  if (options.category) params.set('category', options.category);
  if (options.open) params.set('open', '1');
  if (options.status) params.set('status', options.status);
  if (options.back) params.set('back', options.back);
  return { pathname: `/${mode}`, search: params.size ? `?${params}` : '' };
}

/** Return state is an internal reading location, never an arbitrary redirect URL. */
export function returnTarget(raw: string | null): ReaderLink | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  let url: URL;
  try { url = new URL(raw, 'https://reader.invalid'); } catch { return null; }
  if (url.origin !== 'https://reader.invalid' || !['/', '/current', '/activities', '/favorites'].includes(url.pathname) || url.hash) return null;
  const params = new URLSearchParams();
  const allowed = url.pathname === '/' ? ['date', 'view', 'q', 'category', 'open', 'detail', 'row', 'missing'] : ['activity', 'q', 'category', 'open', 'status'];
  for (const key of allowed) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  if (params.has('date') && !isCalendarDate(params.get('date'))) return null;
  if (params.has('view') && !['new', 'list'].includes(params.get('view')!)) return null;
  if (params.has('open') && params.get('open') !== '1') return null;
  if (params.has('status') && !['passed', 'unknown'].includes(params.get('status')!)) return null;
  return { pathname: url.pathname, search: params.size ? `?${params}` : '' };
}

export function returnKey(target: ReaderLink): string {
  const safe = returnTarget(target.pathname + target.search);
  return safe ? safe.pathname + safe.search : '/';
}

/** Migrate known old publication links without guessing an unavailable issue. */
export function legacyLocation(catalog: BulletinCatalog, pathname: string, params: URLSearchParams, today: string): ReaderLink | null {
  const oldHistory = pathname === '/history';
  const issueId = params.get('issue');
  const detailKey = params.get('detail');
  const filters = { q: params.get('q') ?? '', category: params.get('category') ?? '' };
  const allHistory = oldHistory && (!issueId || issueId === 'all');
  if (allHistory && !detailKey) return activityLink(null, 'activities', filters);
  const issue = issueId && issueId !== 'all' ? catalog.issues.find(item => item.id === issueId) : undefined;
  if (oldHistory && issueId && issueId !== 'all' && !issue) return null;
  if (!detailKey) return oldHistory && issue ? diaryLink(issue.date, 'list', filters) : null;

  const printed = catalog.details.find(source => source.id === detailKey);
  const explicitDate = isCalendarDate(params.get('date')) ? params.get('date') : null;
  const originDate = issue?.date ?? explicitDate;
  const origin = originDate ? diaryLink(originDate, 'list', filters) : allHistory ? activityLink(null, 'activities', filters) : null;
  const back = params.get('back') ?? (origin ? returnKey(origin) : undefined);
  if (printed) {
    const sourceIssue = catalog.issues.find(item => item.id === printed.issue_id)!;
    if (!oldHistory && explicitDate === sourceIssue.date && params.get('view') !== 'list') return null;
    return diaryLink(sourceIssue.date, 'new', { detail: printed.id, back });
  }
  const activityId = resolveIdentity(catalog, detailKey);
  if (!activityId) return null;
  const sources = indexDetails(catalog).get(activityId) ?? [];
  const before = (sourceIssue: BulletinIssue) => issue ? sourceIssue.date < issue.date ||
    (sourceIssue.date === issue.date && sourceIssue.number <= issue.number) : sourceIssue.date <= (explicitDate ?? today);
  const source = (issue && sources.find(item => item.issue.id === issue.id)) || sources.find(item => before(item.issue));
  if (!source) return issue || explicitDate ? diaryLink(issue?.date ?? explicitDate!, 'list', { ...filters, missing: activityId }) : activityLink(activityId, 'activities', { ...filters, back });
  return diaryLink(source.issue.date, 'new', { detail: source.detail.id, back });
}

export function sourceLink(issue: BulletinIssue, detailId: string, back?: ReaderLink): ReaderLink {
  return diaryLink(issue.date, 'new', { detail: detailId, back: back ? returnKey(back) : undefined });
}
