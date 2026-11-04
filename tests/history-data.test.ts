import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import MiniSearch from 'minisearch';
import { encodePartitionedFacts } from '../src/history/public-format.mjs';
import { searchOptions } from '../src/history/tokenize.mjs';
import { searchHistory } from '../src/history/search';
import type { Catalog, Manifest, PublicIssue, PublicItemDetail } from '../src/history/types';
import type { StaticDataset } from '../src/history/data';

const version = 'a'.repeat(64), documentId = 'b'.repeat(64);
const item = `item-${'1'.repeat(24)}`, alias = `item-${'4'.repeat(24)}`;
const occurrence = `occ-${'2'.repeat(24)}`, issue = `issue-${'3'.repeat(24)}`;
const prefix = `versions/${version}/reader-v3`;
const manifest: Manifest = { schema_version: 3, generator: 'nannanews-reader-v3', data_version: version,
  counts: { items: 1, occurrences: 1, issues: 1, documents: 1, images: 0, pdfs: 0 },
  files: { issues: `${prefix}/issues.json`, item_index: `${prefix}/item-index.json`, search_index: `${prefix}/search-index.json`, partitions: { [issue]: `${prefix}/part.json` } } };
const issues: PublicIssue[] = [{ id: issue, title: '历史期刊', issue_date: '2025-01-01', issue_number: 1, occurrence_count: 1,
  documents: [{ id: documentId, format: 'html', filename: 'issue.html', claimed_issue_date: null, issue_date: '2025-01-01', pdf_path: null, source_urls: [], warnings: [] }] }];
const row: Catalog['occurrences'][number] = { id: occurrence, item_id: item, issue_id: issue, document_id: documentId,
  kind: 'detail', title: '讲座', category: '活动', preview: '摘要', issue_date: '2025-01-01', source_urls: [], source_hosts: [], colleges: [], dates: [], expiry_date: null, image_count: 0 };
const catalog: Catalog = { items: [{ id: item, aliases: [alias], latest_occurrence_id: occurrence, occurrence_count: 1 }], occurrences: [row] };
const detail: PublicItemDetail = { id: item, latest_occurrence_id: occurrence, occurrences: [{ ...row, dates: [], date_review: null, body_text: '完整的量子研究正文', locator: {}, table_cells: [], college_mentions: [], images: [] }] };
afterEach(() => vi.unstubAllGlobals());

describe('historical snapshot client', () => {
  it.each(['stored', 'http-decoded'])('loads %s gzip transport preserving identities, alias, source membership and full body', async transport => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/' });
    // The module captures document.baseURI during initialization.
    const { loadHistoryDataset } = await import('../src/history/data');
    const encoded = encodePartitionedFacts(catalog, issues, { [item]: detail }, manifest);
    const values = new Map<string, unknown>([[manifest.files.issues, issues], [manifest.files.item_index, encoded.itemIndex], [manifest.files.partitions[issue], encoded.partitions[issue]]]);
    for (const [bucket, shard] of Object.entries(encoded.detailShards)) values.set(`${prefix}/details/${bucket}.json`, shard);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace(/^.*\/history-data\//, '');
      if (path === 'manifest.json') return Response.json(manifest);
      const value = path.endsWith('.gz') ? values.get(path.slice(0, -3)) : undefined;
      if (value === undefined) return new Response(null, { status: 404 });
      return transport === 'stored'
        ? new Response(new Uint8Array(gzipSync(JSON.stringify(value))))
        : new Response(JSON.stringify(value), { headers: { 'Content-Encoding': 'gzip' } });
    });
    const dataset = await loadHistoryDataset();
    expect((await dataset.loadCatalog()).occurrences[0].document_id).toBe(documentId);
    expect(dataset.canonicalItemId(alias)).toBe(item);
    expect((await dataset.loadIssue(issue)).occurrences[0].id).toBe(occurrence);
    expect((await dataset.loadItem(alias)).occurrences[0].body_text).toBe('完整的量子研究正文');
    expect(() => dataset.assetUrl(`versions/${version}/../escape`)).toThrow();
  });
  it('rejects obsolete manifests and surfaces malformed gzip', async () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/' });
    // The module captures document.baseURI during initialization.
    const { loadHistoryDataset } = await import('../src/history/data');
    vi.stubGlobal('fetch', async () => Response.json({ ...manifest, schema_version: 2, generator: 'webnews-static-v2' }));
    await expect(loadHistoryDataset()).rejects.toThrow();
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => String(url).endsWith('manifest.json') ? Response.json(manifest) : new Response('not gzip'));
    await expect(loadHistoryDataset()).rejects.toThrow();
  });
  it.each(['stored', 'http-decoded'])('searches occurrence IDs with %s gzip and retains the loaded index', async transport => {
    const index = new MiniSearch(searchOptions);
    index.addAll([{ id: occurrence, title: '讲座', text: '完整的量子研究正文' }, { id: 'occ-other', title: '通知', text: '普通内容' }]);
    const fetchIndex = vi.fn(async () => transport === 'stored'
      ? new Response(new Uint8Array(gzipSync(JSON.stringify(index))))
      : new Response(JSON.stringify(index), { headers: { 'Content-Encoding': 'gzip' } }));
    vi.stubGlobal('fetch', fetchIndex);
    const dataset = { searchIndexUrl: 'https://example.test/index.json' } as StaticDataset;
    expect(await searchHistory(dataset, '量子')).toEqual([occurrence]);
    expect(await searchHistory(dataset, '研究')).toEqual([occurrence]);
    expect(fetchIndex).toHaveBeenCalledTimes(1);
    const abort = new AbortController(); abort.abort();
    await expect(searchHistory(dataset, '量子', abort.signal)).rejects.toBeDefined();
  });
  it('does not turn a missing search index into empty results and permits retry', async () => {
    const index = new MiniSearch(searchOptions);
    index.add({ id: occurrence, title: '量子', text: '正文' });
    const fetchIndex = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(gzipSync(JSON.stringify(index)))));
    vi.stubGlobal('fetch', fetchIndex);
    const dataset = { searchIndexUrl: 'https://example.test/index.json' } as StaticDataset;
    await expect(searchHistory(dataset, '量子')).rejects.toThrow();
    expect(await searchHistory(dataset, '量子')).toEqual([occurrence]);
    expect(fetchIndex).toHaveBeenCalledTimes(2);
  });
});
