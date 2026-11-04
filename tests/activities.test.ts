import { describe, expect, it } from 'vitest';
import { activityCutoff, aggregateActivities, searchActivities } from '../src/activities';
import { parseCatalog } from '../src/reader';
import type { BulletinCatalog, BulletinIssue, DetailSource, ListingSource } from '../src/types';

const issue = (id: string, date: string, number: number): BulletinIssue => ({
  id, date, number, title: id, filename: `${id}.pdf`, sha256: number.toString(16).padStart(64, '0'), extraction_version: 'test',
});
const listing = (id: string, issue_id: string, order: number, title: string, category: string, cutoff: string | null): ListingSource => ({
  id, issue_id, order, title, category, cutoff, cutoff_raw: cutoff ?? '未知', listed_on: null, listed_raw: '', source_urls: ['https://example.org/shared'], page: 1,
});
const detail = (id: string, issue_id: string, order: number, title: string, category: string, text: string): DetailSource => ({
  id, issue_id, order, title, category, text, fields: [], source_urls: [], other_urls: [], page: 2,
});

function fixture(): BulletinCatalog {
  return parseCatalog({
    schema_version: 3,
    issues: [issue('old', '2025-01-01', 1), issue('middle', '2025-01-02', 2), issue('latest', '2025-01-02', 3)],
    activities: ['a', 'b', 'c', 'd'].map(id => ({ id })),
    listings: [
      listing('a-old', 'old', 1, 'Historical title', 'Old category', '2025-12-31'),
      listing('a-middle-later', 'middle', 3, 'Second row', 'Other category', '2025-02-01'),
      listing('a-middle-first', 'middle', 1, 'Current listing', 'Listing category', '2025-01-31'),
      listing('b-list', 'latest', 1, 'Shared', 'Listing category', null),
      listing('c-list', 'latest', 2, 'Shared', 'Listing category', '2025-01-04'),
      listing('d-known', 'middle', 4, 'Known row', 'Listing category', '2025-02-01'),
      listing('d-unknown', 'middle', 5, 'Unknown row', 'Listing category', null),
    ],
    details: [
      detail('a-old-body', 'old', 2, 'Old heading', 'Body category', 'Ancient secret text'),
      detail('a-new-body', 'latest', 0, 'Latest heading', 'New category', 'Current body'),
    ],
    publications: [
      { activity_id: 'a', issue_id: 'old', listing_ids: ['a-old'], detail_id: 'a-old-body' },
      { activity_id: 'a', issue_id: 'middle', listing_ids: ['a-middle-later', 'a-middle-first'], detail_id: null },
      { activity_id: 'a', issue_id: 'latest', listing_ids: [], detail_id: 'a-new-body' },
      { activity_id: 'b', issue_id: 'latest', listing_ids: ['b-list'], detail_id: null },
      { activity_id: 'c', issue_id: 'latest', listing_ids: ['c-list'], detail_id: null },
      { activity_id: 'd', issue_id: 'middle', listing_ids: ['d-known', 'd-unknown'], detail_id: null },
    ], identity_aliases: [], warnings: [],
  });
}

describe('activity axis', () => {
  it('keeps one view per identity, newest publication and actual body, without changing sources', () => {
    const catalog = fixture();
    const before = structuredClone(catalog);
    const views = aggregateActivities(catalog);
    expect(views.map(view => view.id)).toEqual(['a', 'b', 'c', 'd']);
    const a = views[0];
    expect(a.publications.map(item => item.issue.id)).toEqual(['latest', 'middle', 'old']);
    expect(a.title).toBe('Latest heading');
    expect(a.latestPublication.issue.id).toBe('latest');
    expect(a.latestListing?.issue.id).toBe('middle');
    expect(a.detail?.issue.id).toBe('latest');
    expect(a.detail?.detail.text).toBe('Current body');
    expect(new Set(a.categories)).toEqual(new Set(['Old category', 'Other category', 'Listing category', 'Body category', 'New category']));
    expect(views.find(view => view.id === 'b')?.detail).toBeNull();
    expect(views.find(view => view.id === 'b')?.title).toBe('Shared');
    expect(catalog).toEqual(before);
  });

  it('uses only the most recent listing snapshot, retaining unknown rows and body-only history', () => {
    const views = aggregateActivities(fixture());
    expect(activityCutoff(views.find(view => view.id === 'a')!)).toBe('2025-02-01');
    expect(activityCutoff(views.find(view => view.id === 'b')!)).toBeNull();
    expect(activityCutoff(views.find(view => view.id === 'd')!)).toBeNull();
    const bodyOnly = fixture();
    bodyOnly.issues = bodyOnly.issues.filter(issue => issue.id === 'latest');
    bodyOnly.activities = [{ id: 'a' }];
    bodyOnly.listings = [];
    bodyOnly.details = bodyOnly.details.filter(detail => detail.id === 'a-new-body');
    bodyOnly.publications = bodyOnly.publications.filter(p => p.activity_id === 'a' && p.issue_id === 'latest');
    expect(activityCutoff(aggregateActivities(parseCatalog(bodyOnly))[0])).toBeNull();
  });

  it('uses the newest listing title but retains the latest actual older body', () => {
    const catalog = fixture();
    catalog.publications = catalog.publications.filter(p => !(p.activity_id === 'a' && p.issue_id === 'latest'));
    catalog.details = catalog.details.filter(detail => detail.id !== 'a-new-body');
    const a = aggregateActivities(parseCatalog(catalog)).find(view => view.id === 'a')!;
    expect(a.title).toBe('Current listing');
    expect(a.detail?.issue.id).toBe('old');
    expect(a.detail?.detail.id).toBe('a-old-body');
  });

  it('returns historical matching sources once, ordered by issue and original source order', () => {
    const views = aggregateActivities(fixture());
    const historical = searchActivities(views, ' ANCIENT SECRET ', '');
    expect(historical.map(match => match.activity.id)).toEqual(['a']);
    expect(historical[0].hits.map(hit => [hit.issue.id, hit.kind, hit.source.id])).toEqual([['old', 'detail', 'a-old-body']]);
    expect(searchActivities(views, 'historical title', '')[0].hits[0].source.id).toBe('a-old');
    const allA = searchActivities(views, '', 'Listing category').find(match => match.activity.id === 'a')!;
    expect(allA.hits.map(hit => [hit.issue.id, hit.source.id])).toEqual([['middle', 'a-middle-first']]);
    const broad = searchActivities(views, 'category', '').find(match => match.activity.id === 'a')!;
    expect(broad.hits.map(hit => hit.source.id)).toEqual(['a-new-body', 'a-middle-first', 'a-middle-later', 'a-old', 'a-old-body']);
    expect(searchActivities(views, '', '').map(match => match.activity.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('scopes keywords to actual category sources and never merges shared URLs or titles', () => {
    const views = aggregateActivities(fixture());
    expect(searchActivities(views, 'ancient', 'Old category')).toEqual([]);
    expect(searchActivities(views, 'ancient', 'Body category')[0].hits[0].issue.id).toBe('old');
    expect(searchActivities(views, 'historical', 'Body category')).toEqual([]);
    expect(searchActivities(views, '', 'Body category').map(match => match.activity.id)).toEqual(['a']);
    expect(searchActivities(views, 'shared', '').map(match => match.activity.id)).toEqual(['b', 'c']);
  });
});
