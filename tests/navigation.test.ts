import { expect, it } from 'vitest';
import { activityLink, diaryLink, legacyLocation, returnKey, returnTarget } from '../src/navigation';
import type { BulletinCatalog, BulletinIssue } from '../src/types';

const issue = (id: string, date: string, number: number): BulletinIssue => ({ id, date, number, title: id, filename: `${id}.pdf`, sha256: number.toString(16).padStart(64, '0'), extraction_version: 'test' });
const catalog: BulletinCatalog = {
  schema_version: 3,
  issues: [issue('old', '2026-11-01', 1), issue('current', '2026-11-02', 2), issue('later', '2026-11-03', 3)],
  activities: [{ id: 'activity' }],
  listings: [{ id: 'current-row', issue_id: 'current', category: '活动', order: 0, title: '清单短标题', cutoff: '2027-01-15', cutoff_raw: '01-15', listed_on: '2026-11-01', listed_raw: '11-01', source_urls: [], page: 1 }],
  details: [
    { id: 'old-body', issue_id: 'old', category: '活动', order: 0, title: '原刊完整标题', text: '原刊正文', fields: [], source_urls: [], other_urls: [], page: 1 },
    { id: 'later-body', issue_id: 'later', category: '活动', order: 0, title: '后续原刊标题', text: '后续正文', fields: [], source_urls: [], other_urls: [], page: 1 },
  ],
  publications: [
    { activity_id: 'activity', issue_id: 'old', listing_ids: [], detail_id: 'old-body' },
    { activity_id: 'activity', issue_id: 'current', listing_ids: ['current-row'], detail_id: null },
    { activity_id: 'activity', issue_id: 'later', listing_ids: [], detail_id: 'later-body' },
  ],
  identity_aliases: [{ legacy_id: 'saved-before-migration', activity_id: 'activity' }], warnings: [],
};

it('moves old publication links to the actual earlier source and retains the originating list context', () => {
  const target = legacyLocation(catalog, '/history', new URLSearchParams({ issue: 'current', detail: 'saved-before-migration', q: '检索词', category: '活动' }), '2026-11-02')!;
  const params = new URLSearchParams(target.search);
  expect(target.pathname).toBe('/');
  expect(params.get('date')).toBe('2026-11-01');
  expect(params.get('detail')).toBe('old-body');
  const back = returnTarget(params.get('back'))!;
  const origin = new URLSearchParams(back.search);
  expect(origin.get('date')).toBe('2026-11-02');
  expect(origin.get('view')).toBe('list');
  expect(origin.get('q')).toBe('检索词');
});

it('does not borrow future text when an old publication link has no collected explanation', () => {
  const withoutPast = { ...catalog, issues: catalog.issues.filter(item => item.id !== 'old'), details: catalog.details.filter(item => item.id !== 'old-body'), publications: catalog.publications.filter(item => item.issue_id !== 'old') };
  const target = legacyLocation(withoutPast, '/history', new URLSearchParams({ issue: 'current', detail: 'activity' }), '2026-11-02')!;
  const params = new URLSearchParams(target.search);
  expect(target.pathname).toBe('/');
  expect(params.get('date')).toBe('2026-11-02');
  expect(params.get('view')).toBe('list');
  expect(params.get('missing')).toBe('activity');
  expect(params.has('detail')).toBe(false);
});

it('keeps valid new source links stable and refuses to guess unknown old issues', () => {
  const direct = diaryLink('2026-11-01', 'new', { detail: 'old-body' });
  expect(legacyLocation(catalog, direct.pathname, new URLSearchParams(direct.search), '2026-11-02')).toBeNull();
  expect(legacyLocation(catalog, '/history', new URLSearchParams({ issue: 'not-collected' }), '2026-11-02')).toBeNull();
  expect(legacyLocation(catalog, '/history', new URLSearchParams({ issue: 'all', q: '原文' }), '2026-11-02')).toEqual(activityLink(null, 'activities', { q: '原文' }));
});

it('preserves source and alias detail targets from the old all-history entry', () => {
  const alias = legacyLocation(catalog, '/history', new URLSearchParams({ issue: 'all', detail: 'saved-before-migration', q: '原刊' }), '2026-11-02')!;
  const aliasParams = new URLSearchParams(alias.search);
  expect(aliasParams.get('detail')).toBe('old-body');
  expect(aliasParams.get('date')).toBe('2026-11-01');
  const origin = returnTarget(aliasParams.get('back'))!;
  expect(origin.pathname).toBe('/activities');
  expect(new URLSearchParams(origin.search).get('q')).toBe('原刊');
  const source = legacyLocation(catalog, '/history', new URLSearchParams({ detail: 'old-body' }), '2026-11-02')!;
  expect(new URLSearchParams(source.search).get('detail')).toBe('old-body');
});

it('only accepts internal reading locations as return targets and drops nested return state', () => {
  for (const unsafe of ['https://example.org/', '//example.org/', '/\\example.org/', '/unknown', '/?date=2026-02-30', '/?view=unknown', '/activities#external', '/\n/[']) {
    expect(returnTarget(unsafe)).toBeNull();
  }
  const safe = returnTarget('/?date=2026-12-31&view=list&q=关键字&open=1&back=https%3A%2F%2Fexample.org')!;
  const params = new URLSearchParams(safe.search);
  expect(params.get('date')).toBe('2026-12-31');
  expect(params.get('view')).toBe('list');
  expect(params.get('q')).toBe('关键字');
  expect(params.get('open')).toBe('1');
  expect(params.has('back')).toBe(false);
  expect(returnTarget(returnKey(safe))).toEqual(safe);
});
