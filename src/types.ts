export interface BulletinIssue {
  id: string;
  date: string;
  number: number;
  title: string;
  filename: string;
  sha256: string;
}

export interface BulletinEntry {
  /** Stable message identity across repeat listings; never includes the cutoff. */
  id: string;
  issue_id: string;
  title: string;
  category: string;
  kind: 'activity' | 'notice';
  /** Original PDF list cutoff, not a registration deadline or an event date. */
  cutoff: string | null;
  cutoff_raw: string;
  listed_on: string | null;
  time: string | null;
  location: string | null;
  summary: string;
  text: string;
  source_urls: string[];
  page: number;
}

export interface BulletinWarning {
  filename: string;
  code: string;
  message: string;
}

export interface BulletinCatalog {
  schema_version: 1;
  issues: BulletinIssue[];
  entries: BulletinEntry[];
  warnings: BulletinWarning[];
}
