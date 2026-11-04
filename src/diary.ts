import { entryCutoff, publicationViews } from './reader';
import type { BulletinCatalog, BulletinIssue, DetailSource, PublicationView } from './types';

export interface PrintedMessage {
  activityId: string;
  issue: BulletinIssue;
  detail: DetailSource;
}

export interface DiaryDay {
  date: string;
  issues: BulletinIssue[];
  publications: PublicationView[];
  details: PrintedMessage[];
  state: 'new' | 'no-new' | 'unrecorded';
}

const sourceOrder = (publication: PublicationView): number =>
  publication.listings[0]?.order ?? publication.detail!.order;

function emptyDay(date: string): DiaryDay {
  return { date, issues: [], publications: [], details: [], state: 'unrecorded' };
}

/** Build a date-owned index from accepted issue and publication relations only. */
export function buildDiaryIndex(catalog: BulletinCatalog): Map<string, DiaryDay> {
  const issuesById = new Map(catalog.issues.map(issue => [issue.id, issue]));
  const index = new Map<string, DiaryDay>();

  for (const issue of catalog.issues) {
    let day = index.get(issue.date);
    if (!day) {
      day = emptyDay(issue.date);
      index.set(issue.date, day);
    }
    day.issues.push(issue);
  }

  for (const publication of publicationViews(catalog)) {
    const issue = issuesById.get(publication.issue_id)!;
    const day = index.get(issue.date)!;
    day.publications.push(publication);
    if (publication.detail) {
      day.details.push({ activityId: publication.id, issue, detail: publication.detail });
    }
  }

  for (const day of index.values()) {
    day.issues.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
    day.publications.sort((a, b) => {
      const issueA = issuesById.get(a.issue_id)!;
      const issueB = issuesById.get(b.issue_id)!;
      return issueA.number - issueB.number || issueA.id.localeCompare(issueB.id) || sourceOrder(a) - sourceOrder(b);
    });
    day.details.sort((a, b) => a.issue.number - b.issue.number || a.issue.id.localeCompare(b.issue.id) || a.detail.order - b.detail.order);
    day.state = day.details.length ? 'new' : 'no-new';
  }

  return index;
}

/** Return a recorded day or an explicitly unrecorded date; invalid dates are rejected. */
export function diaryDay(index: ReadonlyMap<string, DiaryDay>, date: string): DiaryDay {
  if (!isCalendarDate(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  return index.get(date) ?? emptyDay(date);
}

/** True only for an exact, possible YYYY-MM-DD date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Shift a calendar date by whole UTC days without local-time or DST effects. */
export function shiftDay(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  if (!Number.isSafeInteger(days)) throw new RangeError('Day shift must be a safe integer');

  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  const year = shifted.getUTCFullYear();
  if (Number.isNaN(shifted.valueOf()) || year < 0 || year > 9999) {
    throw new RangeError(`Shift is outside the four-digit calendar range: ${date}`);
  }
  const twoDigits = (value: number) => String(value).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${twoDigits(shifted.getUTCMonth() + 1)}-${twoDigits(shifted.getUTCDate())}`;
}


/** Find the newest recorded issue date no later than the supplied date. */
export function recentRecordedDay(index: ReadonlyMap<string, DiaryDay>, onOrBeforeDate: string): string | null {
  if (!isCalendarDate(onOrBeforeDate)) throw new RangeError(`Invalid calendar date: ${onOrBeforeDate}`);

  let recent: string | null = null;
  for (const [date, day] of index) {
    if (day.issues.length && isCalendarDate(date) && date <= onOrBeforeDate && (recent === null || date > recent)) {
      recent = date;
    }
  }
  return recent;
}

/** Preserve full source years and unknown-date text without guessing a year. */
export function formatSourceDate(standardDate: string | null, raw = ''): string {
  if (standardDate === null) return raw || '未明确';
  return isCalendarDate(standardDate) ? standardDate : raw || standardDate || '未明确';
}

/** Select eligible publication snapshots without changing any original source row. */
export function openDiaryPublications(publications: readonly PublicationView[], today: string): PublicationView[] {
  if (!isCalendarDate(today)) throw new RangeError(`Invalid current date: ${today}`);
  const current: { publication: PublicationView; cutoff: string }[] = [];
  const unknown: PublicationView[] = [];
  for (const publication of publications) {
    const cutoff = entryCutoff(publication);
    if (cutoff === null) unknown.push(publication);
    else if (cutoff >= today) current.push({ publication, cutoff });
  }
  current.sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  return [...current.map(item => item.publication), ...unknown];
}
