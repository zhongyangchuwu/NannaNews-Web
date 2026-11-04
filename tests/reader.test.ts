import { describe, expect, it } from 'vitest';
import { beijingToday, dailyGroups, entryCutoff, filterEntries, historyEntries, indexDetails, latestEntries, listingGroups, parseCatalog, publicationViews, resolveDetail, resolveIdentity, safeSourceUrl, sortedIssues } from '../src/reader';
import type { BulletinCatalog, BulletinIssue, DetailSource, ListingSource, PublicationView } from '../src/types';

const issue = (id: string, date: string, number: number): BulletinIssue => ({ id, date, number, title: id, filename: `${id}.pdf`, sha256: number.toString(16).padStart(64, '0'), extraction_version: 'test' });
const listing = (id: string, order: number, cutoff: string | null, category = '活动'): ListingSource => ({ id, issue_id: 'new', category, order, title: id, cutoff, cutoff_raw: cutoff ?? '待明确', listed_on: null, listed_raw: '', source_urls: [], page: 1 });
const detail = (id: string, issue_id: string, order: number, text: string): DetailSource => ({ id, issue_id, order, category: '活动', title: id, text, fields: [], source_urls: [], other_urls: [], page: 1 });
const catalog: BulletinCatalog = {
  schema_version: 3,
  issues: [issue('old', '2025-04-01', 1), issue('new', '2025-04-02', 2), issue('future', '2025-04-03', 3)],
  activities: ['a', 'b', 'notice', 'future-only'].map(id => ({ id })),
  listings: [listing('a1', 0, '2025-04-20'), listing('b', 1, '2025-04-03', '通知'), listing('a2', 2, '2025-04-10')],
  details: [detail('old-body', 'old', 0, 'historical search text'), detail('notice-body', 'new', 3, '本期独立说明'), detail('future-body', 'future', 0, 'future text')],
  publications: [
    { activity_id: 'a', issue_id: 'old', listing_ids: [], detail_id: 'old-body' },
    { activity_id: 'a', issue_id: 'new', listing_ids: ['a1', 'a2'], detail_id: null },
    { activity_id: 'b', issue_id: 'new', listing_ids: ['b'], detail_id: null },
    { activity_id: 'notice', issue_id: 'new', listing_ids: [], detail_id: 'notice-body' },
    { activity_id: 'future-only', issue_id: 'future', listing_ids: [], detail_id: 'future-body' },
  ], identity_aliases: [{ legacy_id: 'legacy-a', activity_id: 'a' }], warnings: [],
};

describe('canonical graph validation', () => {
  it('keeps absent logical detail and an empty master free of invented content', () => {
    const current = publicationViews(parseCatalog(catalog)).find(view => view.id === 'a' && view.issue_id === 'new')!;
    expect(current.detail).toBeNull();
    const empty = parseCatalog({ schema_version: 3, issues: [], activities: [], listings: [], details: [], publications: [], identity_aliases: [], warnings: [] });
    expect(publicationViews(empty)).toEqual([]);
    expect(resolveIdentity(empty, 'saved-but-unavailable')).toBeNull();
  });
  it('rejects malformed, duplicated, orphaned and cross-issue facts', () => {
    const invalid: unknown[] = [
      { ...catalog, schema_version: 2 }, { ...catalog, private: true },
      { ...catalog, issues: [issue('bad', '2025-02-30', 1)] },
      { ...catalog, issues: [...catalog.issues, issue('orphan', '2025-04-04', 4)] },
      { ...catalog, issues: catalog.issues.map(x => x.id === 'new' ? { ...x, sha256: catalog.issues[0].sha256 } : x) },
      { ...catalog, issues: catalog.issues.map(x => x.id === 'new' ? { ...x, date: catalog.issues[0].date, number: catalog.issues[0].number } : x) },
      { ...catalog, listings: catalog.listings.map(x => x.id === 'a1' ? { ...x, title: ' ' } : x) },
      { ...catalog, details: catalog.details.map(x => x.id === 'old-body' ? { ...x, fields: [{ label: ' ', value: '正文' }] } : x) },
      { ...catalog, details: catalog.details.map(x => x.id === 'old-body' ? { ...x, fields: [{ label: '说明', value: ' ' }] } : x) },
      { ...catalog, activities: [...catalog.activities, { id: 'a' }] },
      { ...catalog, listings: [...catalog.listings, { ...catalog.listings[0] }] },
      { ...catalog, listings: catalog.listings.map(x => x.id === 'b' ? { ...x, order: 0 } : x) },
      { ...catalog, listings: [...catalog.listings, listing('orphan', 10, null)] },
      { ...catalog, publications: [...catalog.publications, catalog.publications[0]] },
      { ...catalog, publications: catalog.publications.map(p => p.activity_id === 'b' ? { ...p, listing_ids: ['a1'] } : p) },
      { ...catalog, publications: catalog.publications.map(p => p.activity_id === 'b' ? { ...p, detail_id: 'old-body' } : p) },
      { ...catalog, publications: catalog.publications.map(p => p.activity_id === 'b' ? { ...p, listing_ids: [], detail_id: null } : p) },
      { ...catalog, identity_aliases: [...catalog.identity_aliases, { legacy_id: 'legacy-a', activity_id: 'b' }] },
      { ...catalog, identity_aliases: [{ legacy_id: 'a', activity_id: 'b' }] },
      { ...catalog, identity_aliases: [{ legacy_id: 'unknown', activity_id: 'missing' }] },
      { ...catalog, details: catalog.details.map(d => ({ ...d, private_path: '/private' })) },
    ];
    for (const value of invalid) expect(() => parseCatalog(value)).toThrow();
  });
});

describe('publication reading', () => {
  it('preserves source row order independently of activity grouping and retains cutoff semantics', () => {
    const views = publicationViews(parseCatalog(catalog)).filter(x => x.issue_id === 'new');
    expect(listingGroups(views, true).flatMap(group => group.rows.map(({ row }) => row.id))).toEqual(['a1', 'b', 'a2']);
    expect(entryCutoff(views.find(x => x.id === 'a')!)).toBe('2025-04-20');
    expect(dailyGroups(views, 'new', '2025-04-02').current.map(x => x.id)).toEqual(['b', 'a']);
    const uncertain = { ...views[0], listings: [...views[0].listings, listing('unknown', 5, null)] };
    expect(dailyGroups([uncertain], 'new', '2025-04-02').unknown).toEqual([uncertain]);
    expect(beijingToday(new Date('2025-04-01T16:00:00Z'))).toBe('2025-04-02');
  });
  it('keeps global cutoff priority when categories alternate', () => {
    const views: PublicationView[] = [
      { id: 'late', issue_id: 'new', category: '活动', listings: [listing('late', 0, '2025-04-20')], detail: null },
      { id: 'soon', issue_id: 'new', category: '活动', listings: [listing('soon', 2, '2025-04-02')], detail: null },
      { id: 'middle', issue_id: 'new', category: '通知', listings: [listing('middle', 1, '2025-04-03', '通知')], detail: null },
    ];
    const groups = listingGroups(dailyGroups(views, 'new', '2025-04-02').current);
    expect(groups.map(group => group.category)).toEqual(['活动', '通知', '活动']);
    expect(groups.flatMap(group => group.rows.map(({ row }) => row.id))).toEqual(['soon', 'middle', 'late']);
  });
  it('resolves historical bodies only backward for the same activity', () => {
    const views = publicationViews(catalog); const index = indexDetails(catalog);
    const current = views.find(x => x.id === 'a' && x.issue_id === 'new')!;
    const source = resolveDetail(current, catalog.issues[1], index)!;
    expect(source.issue.id).toBe('old'); expect(current.detail).toBeNull();
    expect(resolveDetail({ ...current, id: 'future-only' }, catalog.issues[1], index)).toBeNull();
    const sources = new Map([[`new\0a`, source]]);
    expect(filterEntries([current], 'historical search', '', sources)).toEqual([current]);
    expect(filterEntries([current], 'historical search', '')).toEqual([]);
  });
  it('keeps selected issue search scoped and chooses newest matching history occurrence', () => {
    expect(sortedIssues(catalog.issues).map(x => x.id)).toEqual(['future', 'new', 'old']);
    expect(historyEntries(catalog, 'new', 'historical search')).toEqual([]);
    expect(historyEntries(catalog, 'all', 'historical search').map(x => x.issue_id)).toEqual(['old']);
    expect(latestEntries(catalog).find(x => x.id === 'a')?.issue_id).toBe('new');
  });
  it('resolves aliases without inventing identities for unknown stored strings', () => {
    expect(resolveIdentity(catalog, 'legacy-a')).toBe('a');
    expect(resolveIdentity(catalog, 'a')).toBe('a');
    expect(resolveIdentity(catalog, 'unresolved')).toBeNull();
  });
  it('retains safe literal source URLs only', () => {
    expect(safeSourceUrl('https://example.org/app#/apply')).toBe('https://example.org/app#/apply');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('https://github.com/nik-nul/NannaNews')).toBeNull();
    expect(safeSourceUrl('https://example.org@evil.test/')).toBeNull();
  });
});
