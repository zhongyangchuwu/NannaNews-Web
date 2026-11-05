import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePartitionedFacts } from '../src/history/public-format.mjs';
import type { Catalog, CatalogOccurrence, Manifest, PublicIssue, PublicItemDetail } from '../src/history/types';

const version = 'a'.repeat(64);
const prefix = `versions/${version}/reader-v3`;
const id = (kind: string, value: number) => `${kind}-${value.toString(16).padStart(24, '0')}`;
const issueIds = [1, 2, 3].map(value => id('issue', value));
const documents = [1, 2, 3].map(value => value.toString(16).padStart(64, '0'));
const alias = id('item', 100);

function fixture() {
  const rows: CatalogOccurrence[] = Array.from({ length: 22 }, (_, index) => {
    const part = index === 21 ? 2 : 0;
    return { id: id('occ', index + 1), item_id: id('item', index + 1), issue_id: issueIds[part], document_id: documents[part],
      kind: 'detail', title: `消息 ${index + 1}`, category: '活动', preview: '', issue_date: part === 0 ? '2025-03-01' : '2023-01-01',
      source_urls: [], source_hosts: [], colleges: [], dates: [], expiry_date: null, image_count: 0 };
  });
  const old = { ...rows[0], id: id('occ', 100), issue_id: issueIds[1], document_id: documents[1], issue_date: '2024-02-01', title: '较早记录' };
  const older = { ...old, id: id('occ', 101), title: '第二条较早记录' };
  const occurrences = [...rows, old, older];
  const items = rows.map((row, index) => ({ id: row.item_id, aliases: index === 0 ? [alias] : [], latest_occurrence_id: row.id, occurrence_count: index === 0 ? 3 : 1 }));
  const catalog: Catalog = { items, occurrences };
  const issues: PublicIssue[] = issueIds.map((issue, index) => ({ id: issue, title: `刊期 ${index}`, issue_date: ['2025-03-01', '2024-02-01', '2023-01-01'][index], issue_number: index + 1,
    occurrence_count: [21, 2, 1][index], documents: [{ id: documents[index], format: 'html', filename: `${index}.html`, claimed_issue_date: null, issue_date: null, pdf_path: null, source_urls: [], warnings: [] }] }));
  const manifest: Manifest = { schema_version: 3, generator: 'nannanews-reader-v3', data_version: version,
    counts: { items: 22, occurrences: 24, issues: 3, documents: 3, images: 0, pdfs: 0 },
    files: { issues: `${prefix}/issues.json`, item_index: `${prefix}/items.json`, search_index: `${prefix}/search.json`, history_index: `${prefix}/history.json`, selection_index: `${prefix}/selection.json`,
      partitions: Object.fromEntries(issueIds.map((issue, index) => [issue, `${prefix}/part${index}.json`])) } };
  const details: Record<string, PublicItemDetail> = Object.fromEntries(items.map(item => [item.id, { id: item.id, latest_occurrence_id: item.latest_occurrence_id,
    occurrences: occurrences.filter(row => row.item_id === item.id).map(row => ({ ...row, dates: row.dates.map(date => ({ ...date, raw_text: date.normalized_date ?? '', evidence: '' })), date_review: null, body_text: '', locator: {}, table_cells: [], college_mentions: [], images: [] })) }]));
  const encoded = encodePartitionedFacts(catalog, issues, details, manifest);
  const refs = rows.map(({ id, item_id, issue_id }) => ({ id, item_id, issue_id }));
  const selection = occurrences.map(({ id, item_id, issue_id, category, issue_date, source_hosts, colleges, dates }) => ({ id, item_id, issue_id, category, issue_date, source_hosts, colleges, dates }));
  const values = new Map<string, unknown>([[manifest.files.issues, issues], [manifest.files.item_index, encoded.itemIndex],
    [manifest.files.history_index!, { aliases: { [alias]: rows[0].item_id }, occurrences: refs, options: { categories: [], colleges: [], sources: [] } }],
    [manifest.files.selection_index!, { aliases: { [alias]: rows[0].item_id }, occurrences: selection }],
    ...issueIds.map(issue => [manifest.files.partitions[issue], encoded.partitions[issue]] as [string, unknown])]);
  return { manifest, values, rows, old, older };
}

async function setup(failPath?: string) {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' });
  const data = fixture();
  const requests: string[] = [];
  let fail = !!failPath;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace(/^.*\/history-data\//, '').replace(/\.gz$/, '');
    requests.push(path);
    if (path === 'manifest.json') return Response.json(data.manifest);
    if (path === failPath && fail) { fail = false; return new Response(null, { status: 503 }); }
    const value = data.values.get(path);
    return value === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify(value), { headers: { 'Content-Encoding': 'gzip' } });
  });
  // data.ts captures document.baseURI at module initialization, after this fixture installs it.
  const { loadHistoryDataset } = await import('../src/history/data');
  return { ...data, requests, dataset: await loadHistoryDataset() };
}
afterEach(() => vi.unstubAllGlobals());

describe('archive pages', () => {
  it('pages latest references without loading unrelated partitions, selection or item directory', async () => {
    const { dataset, manifest, requests, rows } = await setup();
    const first = await dataset.loadPage({ page: 1 });
    expect(first).toMatchObject({ total: 22, page: 1, pages: 2, per_page: 20 });
    expect(first.rows.map(row => row.representative.id)).toEqual(rows.slice(0, 20).map(row => row.id));
    expect(first.rows[0]).toMatchObject({ item: { occurrence_count: 3, aliases: [alias] }, matching_count: 3 });
    expect(requests).not.toContain(manifest.files.selection_index);
    expect(requests).not.toContain(manifest.files.item_index);
    expect(requests).not.toContain(manifest.files.partitions[issueIds[1]]);
    expect(requests).not.toContain(manifest.files.partitions[issueIds[2]]);
    const last = await dataset.loadPage({ page: 99 });
    expect(last).toMatchObject({ total: 22, page: 2, pages: 2 });
    expect(last.rows.map(row => row.representative.id)).toEqual(rows.slice(20).map(row => row.id));
    expect((await dataset.loadPage({ page: 1.5 })).page).toBe(1);
  });
  it('filters all occurrences, preserves global counts, and chooses latest if matching otherwise first source match', async () => {
    const { dataset, old, older, rows } = await setup();
    const page = await dataset.loadPage({ page: 1, year: '2024', month: '02' });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ item: { occurrence_count: 3 }, representative: { id: old.id }, matching_count: 2 });
    const search = await dataset.loadPage({ page: 1, searchHits: [older.id, rows[0].id] });
    expect(search.rows[0]).toMatchObject({ representative: { id: rows[0].id }, matching_count: 2 });
  });
  it('resolves favorite aliases, respects empty filters and scopes issue pages', async () => {
    const { dataset, old } = await setup();
    const favorites = await dataset.loadPage({ page: 1, favoriteIds: [alias, id('item', 999)] });
    expect(favorites.rows).toHaveLength(1);
    expect(favorites.rows[0].item.id).toBe(id('item', 1));
    expect(await dataset.loadPage({ page: 9, favoriteIds: [] })).toEqual({ rows: [], total: 0, page: 1, pages: 1, per_page: 20 });
    expect((await dataset.loadPage({ page: 1, searchHits: [] })).total).toBe(0);
    const scoped = await dataset.loadPage({ page: 1, issueId: issueIds[1], favoriteIds: [alias] });
    expect(scoped.rows[0]).toMatchObject({ item: { occurrence_count: 3 }, representative: { id: old.id }, matching_count: 2 });
  });
  it('surfaces partition failures, permits retry, and honors aborts', async () => {
    const failedPath = `${prefix}/part0.json`;
    const { dataset } = await setup(failedPath);
    await expect(dataset.loadPage({ page: 1 })).rejects.toThrow();
    expect((await dataset.loadPage({ page: 1 })).total).toBe(22);
    const controller = new AbortController(); controller.abort();
    await expect(dataset.loadPage({ page: 1 }, controller.signal)).rejects.toBeDefined();
  });
  it('aborts an in-flight page without poisoning a later request', async () => {
    const { dataset, values } = await setup();
    const started = Promise.withResolvers<void>();
    let first = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^.*\/history-data\//, '').replace(/\.gz$/, '');
      if (first) {
        first = false;
        started.resolve();
        const response = Promise.withResolvers<Response>();
        init?.signal?.addEventListener('abort', () => response.reject(init?.signal?.reason), { once: true });
        return response.promise;
      }
      const value = values.get(path);
      return value === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify(value), { headers: { 'Content-Encoding': 'gzip' } });
    });
    const controller = new AbortController();
    const pending = dataset.loadPage({ page: 1 }, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect((await dataset.loadPage({ page: 1 })).total).toBe(22);
  });
});
