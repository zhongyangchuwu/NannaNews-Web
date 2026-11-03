export interface BulletinIssue {
  id: string; date: string; number: number; title: string; filename: string; sha256: string; extraction_version: string;
}
export interface Activity { id: string }
export interface ListingSource {
  id: string; issue_id: string; category: string; order: number; title: string;
  cutoff: string | null; cutoff_raw: string; listed_on: string | null; listed_raw: string;
  source_urls: string[]; page: number;
}
export interface DetailSource {
  id: string; issue_id: string; category: string; order: number; title: string; text: string;
  fields: { label: string; value: string }[]; source_urls: string[]; other_urls: string[]; page: number;
}
export interface Publication { activity_id: string; issue_id: string; listing_ids: string[]; detail_id: string | null }
export interface IdentityAlias { legacy_id: string; activity_id: string }
export interface BulletinWarning { filename: string; code: string; message: string }
export interface BulletinCatalog {
  schema_version: 3;
  issues: BulletinIssue[]; activities: Activity[]; listings: ListingSource[]; details: DetailSource[];
  publications: Publication[]; identity_aliases: IdentityAlias[]; warnings: BulletinWarning[];
}
/** A derived publication view, never persisted or backfilled. */
export interface PublicationView {
  id: string; issue_id: string; category: string; listings: ListingSource[]; detail: DetailSource | null;
}
