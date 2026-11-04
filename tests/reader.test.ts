import { describe, expect, it } from 'vitest';
import { beijingToday, dailyGroups, entryCutoff, entryTitle, filterEntries, historyEntries, parseCatalog, safeSourceUrl, sortedIssues } from '../src/reader';
import type { BulletinCatalog, BulletinDetail, BulletinEntry, BulletinIssue, BulletinListing } from '../src/types';

const issue = (id: string, date: string, number: number): BulletinIssue => ({ id, date, number, title: id, filename: `${id}.pdf`, sha256: 'a'.repeat(64) });
const listing = (title: string, cutoff: string | null): BulletinListing => ({
  title, cutoff, cutoff_raw: cutoff?.slice(5) ?? '待明确', listed_on: null, listed_raw: '', source_urls: [], page: 1,
});
const detail = (title: string, text = ''): BulletinDetail => ({ title, text, fields: [], source_urls: [], other_urls: [], page: 1 });
const entry = (id: string, issue_id: string, cutoff: string | null, bodyOnly = false): BulletinEntry => ({
  id, issue_id, category: '活动', listings: bodyOnly ? [] : [listing(id, cutoff)], detail: bodyOnly ? detail(id) : null,
});
const catalog: BulletinCatalog = {
  schema_version: 2,
  issues: [issue('old', '2025-04-01', 1), issue('new', '2025-04-02', 2)],
  entries: [entry('repeat', 'old', '2025-03-01'), entry('repeat', 'new', '2025-04-02'), entry('unknown', 'new', null), entry('notice', 'new', null, true)],
  warnings: [],
};

describe('daily issue selection', () => {
  it('uses Beijing date and retains the cutoff day without extending it from the new explanation', () => {
    expect(beijingToday(new Date('2025-04-01T16:00:00Z'))).toBe('2025-04-02');
    const expired = { ...entry('expired', 'new', '2025-04-01'), detail: detail('本期详解', '报名截止 2025-04-30') };
    const groups = dailyGroups([...catalog.entries, expired], 'new', '2025-04-02');
    expect(groups.current.map(item => item.id)).toEqual(['repeat']);
    expect(groups.unknown.map(item => item.id)).toEqual(['unknown']);
    expect(groups.notices.map(item => item.id)).toEqual(['notice']);
  });
  it('places the nearest clear cutoff first, regardless of PDF category order', () => {
    const entries = [entry('later', 'new', '2025-04-20'), entry('today', 'new', '2025-04-02')];
    expect(dailyGroups(entries, 'new', '2025-04-02').current.map(item => item.id)).toEqual(['today', 'later']);
  });
  it('retains original rows and does not mask an uncertain row with a later clear cutoff', () => {
    const multiple = { ...entry('multiple', 'new', '2025-04-03'), listings: [listing('第一场', '2025-04-03'), listing('第二场', '2025-04-08')] };
    expect(entryCutoff(multiple)).toBe('2025-04-08');
    expect(entryTitle(multiple)).toBe('第一场');
    const uncertain = { ...multiple, listings: [...multiple.listings, listing('第三场', null)] };
    expect(dailyGroups([uncertain], 'new', '2025-04-02').unknown).toEqual([uncertain]);
  });
});

describe('source explanations and history', () => {
  it('finds the original detail-heading qualifier even when the table titles are identical', () => {
    const medical = { ...entry('a', 'new', '2025-04-20'), listings: [listing('校园比赛', '2025-04-20')], detail: detail('校园比赛甲学院报名') };
    const arts = { ...entry('b', 'new', '2025-04-20'), listings: [listing('校园比赛', '2025-04-20')], detail: detail('校园比赛乙学院报名') };
    expect(filterEntries([medical, arts], '甲学院', '').map(item => item.id)).toEqual(['a']);
    expect(dailyGroups([medical], 'new', '2025-04-02').notices).toEqual([]);
  });
  it('selects actual issues including expired entries and deduplicates by newest matching occurrence', () => {
    expect(sortedIssues(catalog.issues).map(item => item.id)).toEqual(['new', 'old']);
    expect(historyEntries(catalog, 'old').map(entryCutoff)).toEqual(['2025-03-01']);
    expect(historyEntries(catalog, 'all').filter(item => item.id === 'repeat').map(item => item.issue_id)).toEqual(['new']);
    const withOldText = { ...catalog, entries: catalog.entries.map(item => item.issue_id === 'old' ? { ...item, detail: detail('原刊说明', 'earlier detail') } : item) };
    expect(historyEntries(withOldText, 'all', 'earlier detail').map(item => item.issue_id)).toEqual(['old']);
  });
});

describe('catalog and links', () => {
  it('rejects wrong versions, references, invalid dates, duplicate IDs and unprojected private fields', () => {
    expect(parseCatalog(catalog)).toBe(catalog);
    expect(() => parseCatalog({ ...catalog, schema_version: 1 })).toThrow();
    expect(() => parseCatalog({ ...catalog, entries: [entry('x', 'missing', null)] })).toThrow();
    expect(() => parseCatalog({ ...catalog, entries: [entry('x', 'new', '2025-02-30')] })).toThrow();
    expect(() => parseCatalog({ ...catalog, entries: [entry('x', 'new', null), entry('x', 'new', null)] })).toThrow();
    expect(() => parseCatalog({ ...catalog, entries: [{ ...entry('x', 'new', null), raw_receipt: 'private' }] })).toThrow();
    expect(() => parseCatalog({ ...catalog, entries: [{ ...entry('x', 'new', null), listings: [], detail: null }] })).toThrow();
  });
  it('preserves literal HTTP destinations, including hash routes, while excluding unsafe/newsletter links', () => {
    expect(safeSourceUrl('https://example.org/app#/apply')).toBe('https://example.org/app#/apply');
    expect(safeSourceUrl('https://example.org/')).toBe('https://example.org/');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('https://github.com/nik-nul/NannaNews')).toBeNull();
    expect(safeSourceUrl('https://zhongyangchuwu.github.io/%4eannaNews/issue')).toBeNull();
    expect(safeSourceUrl('https://nannanews.example.org/news')).toBe('https://nannanews.example.org/news');
    expect(safeSourceUrl('https://example.org@evil.test/')).toBeNull();
  });
});
