import { describe, expect, it } from 'vitest';
import { beijingToday, dailyGroups, historyEntries, parseCatalog, safeSourceUrl, sortedIssues } from '../src/reader';
import type { BulletinCatalog, BulletinEntry, BulletinIssue } from '../src/types';

const issue = (id: string, date: string, number: number): BulletinIssue => ({ id, date, number, title: id, filename: `${id}.pdf`, sha256: 'hash' });
const entry = (id: string, issue_id: string, cutoff: string | null, kind: 'activity' | 'notice' = 'activity'): BulletinEntry => ({
  id, issue_id, cutoff, kind, title: id, category: '活动', cutoff_raw: '', listed_on: null,
  time: null, location: null, summary: '', text: '', source_urls: [], page: 1,
});
const catalog: BulletinCatalog = {
  schema_version: 1,
  issues: [issue('old', '2025-04-01', 1), issue('new', '2025-04-02', 2)],
  entries: [entry('repeat', 'old', '2025-03-01'), entry('repeat', 'new', '2025-04-02'), entry('unknown', 'new', null), entry('notice', 'new', null, 'notice')],
  warnings: [],
};

describe('daily issue selection', () => {
  it('uses Beijing date and includes the cutoff day, not an earlier cutoff even if text mentions a later application date', () => {
    expect(beijingToday(new Date('2025-04-01T16:00:00Z'))).toBe('2025-04-02');
    const expired = { ...entry('expired', 'new', '2025-04-01'), text: '报名截止 2025-04-30' };
    const groups = dailyGroups([...catalog.entries, expired], 'new', '2025-04-02');
    expect(groups.current.map(item => item.id)).toEqual(['repeat']);
    expect(groups.unknown.map(item => item.id)).toEqual(['unknown']);
    expect(groups.notices.map(item => item.id)).toEqual(['notice']);
  });
  it('places the nearest clear cutoff first, regardless of PDF category order', () => {
    const entries = [entry('later', 'new', '2025-04-20'), entry('today', 'new', '2025-04-02')];
    expect(dailyGroups(entries, 'new', '2025-04-02').current.map(item => item.id)).toEqual(['today', 'later']);
  });
});

describe('history', () => {
  it('selects actual issues including expired entries and deduplicates across issues by newest occurrence', () => {
    expect(sortedIssues(catalog.issues).map(item => item.id)).toEqual(['new', 'old']);
    expect(historyEntries(catalog, 'old').map(item => item.cutoff)).toEqual(['2025-03-01']);
    expect(historyEntries(catalog, 'all').filter(item => item.id === 'repeat').map(item => item.issue_id)).toEqual(['new']);
    const withOldText = { ...catalog, entries: catalog.entries.map(item => item.issue_id === 'old' ? { ...item, text: 'earlier detail' } : item) };
    expect(historyEntries(withOldText, 'all', 'earlier detail').map(item => item.issue_id)).toEqual(['old']);
  });
});

describe('catalog and links', () => {
  it('rejects broken issue references and malformed dates', () => {
    expect(parseCatalog(catalog)).toBe(catalog);
    expect(() => parseCatalog({ ...catalog, entries: [entry('x', 'missing', null)] })).toThrow();
    expect(() => parseCatalog({ ...catalog, entries: [entry('x', 'new', '2025-02-30')] })).toThrow();
  });
  it('permits genuine HTTP links but excludes unsafe and newsletter links', () => {
    expect(safeSourceUrl('https://example.org/event')).toBe('https://example.org/event');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('https://github.com/nik-nul/NannaNews')).toBeNull();
    expect(safeSourceUrl('https://zhongyangchuwu.github.io/%4eannaNews/issue')).toBeNull();
    expect(safeSourceUrl('https://nannanews.example.org/news')).toBe('https://nannanews.example.org/news');
    expect(safeSourceUrl('https://example.org@evil.test/')).toBeNull();
  });
});
