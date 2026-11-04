import { describe, expect, it } from 'vitest';
import { buildDiaryIndex, diaryDay, diaryWindow, formatSourceDate, isCalendarDate, openDiaryPublications, recentRecordedDay, shiftDay } from '../src/diary';
import { parseCatalog } from '../src/reader';
import type { BulletinCatalog, BulletinIssue, DetailSource, ListingSource, PublicationView } from '../src/types';

const issue = (id: string, date: string, number: number): BulletinIssue => ({
  id, date, number, title: id, filename: `${id}.pdf`, sha256: number.toString(16).padStart(64, '0'), extraction_version: 'test',
});
const listing = (id: string, issueId: string, order: number): ListingSource => ({
  id, issue_id: issueId, category: '活动', order, title: id, cutoff: null, cutoff_raw: '', listed_on: null, listed_raw: '', source_urls: [], page: 1,
});
const detail = (id: string, issueId: string, order: number, text = id): DetailSource => ({
  id, issue_id: issueId, category: '活动', order, title: id, text, fields: [], source_urls: [], other_urls: [], page: 1,
});
const publication = (activityId: string, issueId: string, listingIds: string[] = [], detailId: string | null = null) => ({
  activity_id: activityId, issue_id: issueId, listing_ids: listingIds, detail_id: detailId,
});
const catalog = (
  issues: BulletinIssue[],
  publications: BulletinCatalog['publications'],
  listings: ListingSource[] = [],
  details: DetailSource[] = [],
): BulletinCatalog => ({
  schema_version: 3,
  issues,
  activities: [...new Set(publications.map(item => item.activity_id))].map(id => ({ id })),
  listings,
  details,
  publications,
  identity_aliases: [],
  warnings: [],
});

describe('date diary model', () => {
  it('distinguishes a missing date from a recorded issue with no actual details', () => {
    const index = buildDiaryIndex(parseCatalog(catalog([issue('issue-no-details', '2026-01-02', 12)], [publication('listed', 'issue-no-details', ['row'])], [listing('row', 'issue-no-details', 0)])));
    const recorded = diaryDay(index, '2026-01-02');
    const missing = diaryDay(index, '2026-01-03');

    expect(recorded).toMatchObject({ date: '2026-01-02', state: 'no-new', publications: [{ id: 'listed', detail: null }], details: [] });
    expect(recorded.issues.map(item => item.id)).toEqual(['issue-no-details']);
    expect(missing).toEqual({ date: '2026-01-03', issues: [], publications: [], details: [], state: 'unrecorded' });
    expect(index.has('2026-01-03')).toBe(false);
    expect(() => diaryDay(index, '2026-02-30')).toThrow(RangeError);
  });

  it('keeps body-only, listing-only, and historical message sources on their own dates', () => {
    const oldIssue = issue('old', '2020-04-05', 1);
    const latestIssue = issue('latest', '2022-06-07', 3);
    const listingIssue = issue('listing-only-issue', '2024-08-09', 5);
    const data = catalog(
      [oldIssue, latestIssue, listingIssue],
      [
        publication('same-activity', 'old', [], 'old-body'),
        publication('same-activity', 'latest', [], 'latest-body'),
        publication('listed-only', 'listing-only-issue', ['listing'], null),
      ],
      [listing('listing', 'listing-only-issue', 0)],
      [detail('old-body', 'old', 0, 'historical text'), detail('latest-body', 'latest', 0, 'later text')],
    );
    const index = buildDiaryIndex(data);
    const oldDay = diaryDay(index, '2020-04-05');
    const latestDay = diaryDay(index, '2022-06-07');
    const listingDay = diaryDay(index, '2024-08-09');

    expect(oldDay.publications[0]).toMatchObject({ id: 'same-activity', listings: [], detail: { id: 'old-body' } });
    expect(oldDay.details.map(message => [message.activityId, message.detail.text])).toEqual([['same-activity', 'historical text']]);
    expect(latestDay.details.map(message => message.detail.text)).toEqual(['later text']);
    expect(listingDay.publications[0]).toMatchObject({ id: 'listed-only', listings: [{ id: 'listing' }], detail: null });
    expect(listingDay.details).toEqual([]);
    expect(listingDay.state).toBe('no-new');
  });

  it('orders issues, publications, and printed detail sources by their own source order without mutating catalog data', () => {
    const issues = [issue('issue-20', '2025-03-04', 20), issue('issue-2', '2025-03-04', 2), issue('issue-10', '2025-03-04', 10)];
    const listings = [listing('row-second', 'issue-2', 2), listing('row-first', 'issue-2', 1)];
    const details = [
      detail('body-issue-20', 'issue-20', 0),
      detail('body-issue-2', 'issue-2', 3),
      detail('body-with-listing', 'issue-2', 8),
      detail('body-issue-10', 'issue-10', 1),
    ];
    const publications: BulletinCatalog['publications'] = [
      publication('issue-20-message', 'issue-20', [], 'body-issue-20'),
      publication('body-with-listing-message', 'issue-2', ['row-first'], 'body-with-listing'),
      publication('issue-10-message', 'issue-10', [], 'body-issue-10'),
      publication('listing-second-message', 'issue-2', ['row-second']),
      publication('issue-2-message', 'issue-2', [], 'body-issue-2'),
    ];
    const data = catalog(issues, publications, listings, details);
    const original = structuredClone(data);
    const day = buildDiaryIndex(data).get('2025-03-04')!;

    expect(day.issues.map(item => item.number)).toEqual([2, 10, 20]);
    expect(day.publications.map(item => item.id)).toEqual([
      'body-with-listing-message', 'listing-second-message', 'issue-2-message', 'issue-10-message', 'issue-20-message',
    ]);
    expect(day.details.map(message => message.detail.id)).toEqual([
      'body-issue-2', 'body-with-listing', 'body-issue-10', 'body-issue-20',
    ]);
    expect(data).toEqual(original);
  });

  it('builds an inclusive ascending window and finds only recorded dates on or before selection', () => {
    const index = buildDiaryIndex(catalog(
      [issue('with-body', '2025-12-31', 1), issue('without-body', '2026-01-02', 2)],
      [publication('message', 'with-body', [], 'body'), publication('listed', 'without-body', ['row'])],
      [listing('row', 'without-body', 0)],
      [detail('body', 'with-body', 0)],
    ));

    expect(diaryWindow(index, '2026-01-01', 1).map(day => [day.date, day.state, day.details.length])).toEqual([
      ['2025-12-31', 'new', 1], ['2026-01-01', 'unrecorded', 0], ['2026-01-02', 'no-new', 0],
    ]);
    expect(recentRecordedDay(index, '2026-01-01')).toBe('2025-12-31');
    expect(recentRecordedDay(index, '2025-12-30')).toBeNull();
    expect(recentRecordedDay(index, '2025-12-31')).toBe('2025-12-31');
    expect(() => diaryWindow(index, '2026-02-30')).toThrow(RangeError);
  });

  it('validates real calendar dates and shifts across leap days, months, years, and range boundaries', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    for (const value of ['2026-02-30', '1900-02-29', '2024-04-31', '2024-2-09', '2024-02-09T00:00:00Z', '']) {
      expect(isCalendarDate(value)).toBe(false);
    }
    expect(shiftDay('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDay('2024-02-29', 1)).toBe('2024-03-01');
    expect(shiftDay('2025-01-01', -1)).toBe('2024-12-31');
    expect(shiftDay('1999-12-31', 1)).toBe('2000-01-01');
    expect(() => shiftDay('2026-02-30', 1)).toThrow(RangeError);
    expect(() => shiftDay('2024-01-01', 1.5)).toThrow(RangeError);
    expect(() => shiftDay('9999-12-31', 1)).toThrow(RangeError);
  });

  it('keeps the cutoff day and uncertain publications without extending expired listings from body dates', () => {
    const row = (id: string, cutoff: string | null) => ({ ...listing(id, 'selected', 0), cutoff, cutoff_raw: cutoff ?? '日期未明' });
    const expired: PublicationView = { id: 'expired', issue_id: 'selected', category: '活动', listings: [row('expired-row', '2026-01-01')], detail: detail('expired-body', 'selected', 1, '活动时间另见2026年12月') };
    const today: PublicationView = { id: 'today', issue_id: 'selected', category: '活动', listings: [row('today-row', '2026-01-02')], detail: null };
    const unknown: PublicationView = { id: 'unknown', issue_id: 'selected', category: '活动', listings: [row('unknown-row', null)], detail: null };
    const bodyOnly: PublicationView = { id: 'body-only', issue_id: 'selected', category: '活动', listings: [], detail: detail('body', 'selected', 2) };
    expect(openDiaryPublications([expired, unknown, today, bodyOnly], '2026-01-02').map(item => item.id)).toEqual(['today', 'unknown', 'body-only']);
    expect(expired.listings[0].cutoff).toBe('2026-01-01');
    expect(() => openDiaryPublications([today], '2026-02-30')).toThrow(RangeError);
  });

  it('preserves full source years and raw or unspecified unknown dates', () => {
    expect(formatSourceDate('2024-02-29')).toBe('2024-02-29');
    expect(formatSourceDate(null, '约2024年春')).toBe('约2024年春');
    expect(formatSourceDate(null)).toBe('未明确');
    expect(formatSourceDate('2024-02-30', '原文日期未详')).toBe('原文日期未详');
  });
});
