export interface BulletinIssue {
  id: string;
  date: string;
  number: number;
  title: string;
  filename: string;
  sha256: string;
}

/** One original PDF table row, retained even when several rows share a message. */
export interface BulletinListing {
  title: string;
  cutoff: string | null;
  cutoff_raw: string;
  listed_on: string | null;
  listed_raw: string;
  source_urls: string[];
  page: number;
}

/** An original labelled field, not a renamed/inferred business attribute. */
export interface BulletinField {
  label: string;
  value: string;
}

/** The explanation printed in this issue; it can coexist with a table listing. */
export interface BulletinDetail {
  title: string;
  text: string;
  fields: BulletinField[];
  source_urls: string[];
  other_urls: string[];
  page: number;
}

export interface BulletinEntry {
  /** Stable message identity; never includes the changing cutoff. */
  id: string;
  issue_id: string;
  category: string;
  listings: BulletinListing[];
  detail: BulletinDetail | null;
}

export interface BulletinWarning {
  filename: string;
  code: string;
  message: string;
}

export interface BulletinCatalog {
  schema_version: 2;
  issues: BulletinIssue[];
  entries: BulletinEntry[];
  warnings: BulletinWarning[];
}
