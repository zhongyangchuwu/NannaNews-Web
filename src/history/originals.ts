export interface HistoryOriginalAlias {
  filename: string;
  filename_date: string | null;
  content_date: string | null;
  date_status: string;
}

export interface HistoryOriginal {
  sha256: string;
  format: 'html' | 'pdf';
  filename: string;
  size: number;
  kind: 'original' | 'source_pdf';
  path: string;
  aliases: HistoryOriginalAlias[];
  registry_metadata: {
    claimed_date: string | null;
    recorded_issue_date: string | null;
    recorded_issue_number: number | null;
  };
}

export interface HistoryOriginals {
  schema_version: 1;
  generator: 'nannanews-history-originals-v1';
  repository: 'zhongyangchuwu/NannaNews-Web';
  source_ref: string;
  counts: { documents: number; html: number; pdf: number; bytes: number };
  documents: HistoryOriginal[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const basename = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value !== '.' && value !== '..' && !/[\/\\\x00-\x1f\x7f?#]/.test(value);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function requireOriginals(condition: unknown): asserts condition {
  if (!condition) throw new Error('历史原件清单格式无效。');
}

/** Validate public metadata without accessing the browser, filesystem or network. */
export function parseOriginals(value: unknown): HistoryOriginals {
  requireOriginals(record(value) && keys(value, ['schema_version', 'generator', 'repository', 'source_ref', 'counts', 'documents'])
    && value.schema_version === 1 && value.generator === 'nannanews-history-originals-v1'
    && value.repository === 'zhongyangchuwu/NannaNews-Web' && typeof value.source_ref === 'string'
    && /^[a-f0-9]{40}$/.test(value.source_ref) && record(value.counts)
    && keys(value.counts, ['documents', 'html', 'pdf', 'bytes']) && Array.isArray(value.documents));
  const counts = value.counts;
  requireOriginals(nonnegative(counts.documents) && nonnegative(counts.html) && nonnegative(counts.pdf) && nonnegative(counts.bytes));
  const hashes = new Set<string>(), paths = new Set<string>();
  let html = 0, pdf = 0, bytes = 0;
  for (const document of value.documents) {
    requireOriginals(record(document) && keys(document, ['sha256', 'format', 'filename', 'size', 'kind', 'path', 'aliases', 'registry_metadata'])
      && typeof document.sha256 === 'string' && /^[a-f0-9]{64}$/.test(document.sha256) && !hashes.has(document.sha256)
      && (document.format === 'html' || document.format === 'pdf') && basename(document.filename)
      && nonnegative(document.size) && document.size > 0 && (document.kind === 'original' || document.kind === 'source_pdf')
      && typeof document.path === 'string' && !paths.has(document.path) && Array.isArray(document.aliases)
      && record(document.registry_metadata));
    const path = document.path;
    requireOriginals(path === `history/originals/${document.sha256}.${document.format}`
      || (document.format === 'pdf' && path.startsWith('pdf/') && basename(path.slice(4)) && path.endsWith('.pdf')));
    for (const alias of document.aliases) {
      requireOriginals(record(alias) && keys(alias, ['filename', 'filename_date', 'content_date', 'date_status'])
        && basename(alias.filename) && nullableString(alias.filename_date) && nullableString(alias.content_date)
        && typeof alias.date_status === 'string');
    }
    const metadata = document.registry_metadata;
    requireOriginals(keys(metadata, ['claimed_date', 'recorded_issue_date', 'recorded_issue_number'])
      && nullableString(metadata.claimed_date) && nullableString(metadata.recorded_issue_date)
      && (metadata.recorded_issue_number === null || nonnegative(metadata.recorded_issue_number)));
    hashes.add(document.sha256); paths.add(path); bytes += document.size;
    if (document.format === 'html') html++; else pdf++;
  }
  requireOriginals(Number.isSafeInteger(bytes) && counts.documents === value.documents.length
    && counts.html === html && counts.pdf === pdf && counts.bytes === bytes);
  return value as unknown as HistoryOriginals;
}

export async function loadOriginals(signal?: AbortSignal): Promise<HistoryOriginals> {
  const url = new URL('data/history-originals.json', new URL(import.meta.env.BASE_URL, document.baseURI));
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`历史原件清单加载失败（${response.status}）。`);
  const value: unknown = await response.json();
  signal?.throwIfAborted();
  return parseOriginals(value);
}

export function originalUrl(manifest: HistoryOriginals, document: HistoryOriginal, mode: 'view' | 'raw' = 'view'): string {
  const encoded = document.path.split('/').map(encodeURIComponent).join('/');
  return mode === 'raw'
    ? `https://raw.githubusercontent.com/${manifest.repository}/${manifest.source_ref}/${encoded}`
    : `https://github.com/${manifest.repository}/blob/${manifest.source_ref}/${encoded}`;
}
