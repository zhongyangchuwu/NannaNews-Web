import { entryCutoff, publicationViews } from './reader';
import type { DetailSource as DatedDetail } from './reader';
import type { BulletinCatalog, BulletinIssue, DetailSource, ListingSource, PublicationView } from './types';

export interface ActivityPublication { issue: BulletinIssue; publication: PublicationView }
export interface ActivityView {
  id: string;
  title: string;
  categories: string[];
  publications: ActivityPublication[];
  latestPublication: ActivityPublication;
  latestListing: ActivityPublication | null;
  detail: DatedDetail | null;
}
export interface ActivityHit { issue: BulletinIssue; kind: 'listing' | 'detail'; source: ListingSource | DetailSource }
export interface ActivityMatch { activity: ActivityView; hits: ActivityHit[] }

const compareIssues = (a: BulletinIssue, b: BulletinIssue) =>
  b.date.localeCompare(a.date) || b.number - a.number || a.id.localeCompare(b.id);

export function aggregateActivities(catalog: BulletinCatalog): ActivityView[] {
  const issues = new Map(catalog.issues.map(issue => [issue.id, issue]));
  const byActivity = new Map<string, ActivityPublication[]>();
  for (const publication of publicationViews(catalog)) {
    const publications = byActivity.get(publication.id) ?? [];
    publications.push({ issue: issues.get(publication.issue_id)!, publication });
    byActivity.set(publication.id, publications);
  }
  return catalog.activities.map(({ id }) => {
    const publications = byActivity.get(id)!;
    publications.sort((a, b) => compareIssues(a.issue, b.issue));
    const latestPublication = publications[0];
    const latestListing = publications.find(item => item.publication.listings.length > 0) ?? null;
    const latestDetail = publications.find(item => item.publication.detail !== null);
    const categories = new Set<string>();
    for (const { publication } of publications) {
      for (const row of publication.listings) categories.add(row.category);
      if (publication.detail) categories.add(publication.detail.category);
    }
    return {
      id,
      title: latestPublication.publication.listings[0]?.title ?? latestPublication.publication.detail!.title,
      categories: [...categories],
      publications,
      latestPublication,
      latestListing,
      detail: latestDetail ? { issue: latestDetail.issue, detail: latestDetail.publication.detail! } : null,
    };
  }).sort((a, b) => compareIssues(a.latestPublication.issue, b.latestPublication.issue) || a.id.localeCompare(b.id));
}

export function searchActivities(activities: readonly ActivityView[], query: string, category: string): ActivityMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches: ActivityMatch[] = [];
  for (const activity of activities) {
    if (!needle && !category) {
      matches.push({ activity, hits: [] });
      continue;
    }
    const hits: ActivityHit[] = [];
    for (const { issue, publication } of activity.publications) {
      const sources: ActivityHit[] = publication.listings.map(source => ({ issue, kind: 'listing', source }));
      if (publication.detail) sources.push({ issue, kind: 'detail', source: publication.detail });
      sources.sort((a, b) => a.source.order - b.source.order);
      for (const hit of sources) {
        const source = hit.source;
        if (category && source.category !== category) continue;
        if (needle && ![source.category, source.title, 'text' in source ? source.text : '']
          .some(text => text.toLocaleLowerCase().includes(needle))) continue;
        hits.push(hit);
      }
    }
    if (hits.length) matches.push({ activity, hits });
  }
  return matches;
}

export function activityCutoff(activity: ActivityView): string | null {
  return activity.latestListing ? entryCutoff(activity.latestListing.publication) : null;
}
