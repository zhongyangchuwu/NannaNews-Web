// Synthetic CI bundling input only; no original PDF content is included.
import { mkdir, writeFile } from 'node:fs/promises';
const issues = [
  { id: 'old', date: '2098-12-01', number: 1, title: '合成旧刊', filename: 'old.pdf', sha256: 'a'.repeat(64), extraction_version: 'synthetic' },
  { id: 'new', date: '2099-01-01', number: 2, title: '合成新刊', filename: 'new.pdf', sha256: 'b'.repeat(64), extraction_version: 'synthetic' },
];
const catalog = {
  schema_version: 3, issues,
  activities: [{ id: 'shared' }, { id: 'listing-only' }, { id: 'detail-only' }],
  listings: [
    { id: 'a1', issue_id: 'new', category: '讲座', order: 0, title: '合成活动一', cutoff: '2099-01-02', cutoff_raw: '01-02', listed_on: null, listed_raw: '', source_urls: ['https://example.org/notice'], page: 1 },
    { id: 'b', issue_id: 'new', category: '通知', order: 1, title: '合成清单', cutoff: null, cutoff_raw: '待定', listed_on: null, listed_raw: '', source_urls: [], page: 1 },
    { id: 'a2', issue_id: 'new', category: '讲座', order: 2, title: '合成活动二', cutoff: '2099-01-03', cutoff_raw: '01-03', listed_on: null, listed_raw: '', source_urls: [], page: 1 },
  ],
  details: [
    { id: 'historical', issue_id: 'old', category: '讲座', order: 0, title: '合成旧说明', text: '这不是已发布消息。', fields: [], source_urls: [], other_urls: [], page: 1 },
    { id: 'body', issue_id: 'new', category: '通知', order: 3, title: '合成独立说明', text: '仅用于构建检查。', fields: [], source_urls: [], other_urls: [], page: 1 },
  ],
  publications: [
    { activity_id: 'shared', issue_id: 'old', listing_ids: [], detail_id: 'historical' },
    { activity_id: 'shared', issue_id: 'new', listing_ids: ['a1', 'a2'], detail_id: null },
    { activity_id: 'listing-only', issue_id: 'new', listing_ids: ['b'], detail_id: null },
    { activity_id: 'detail-only', issue_id: 'new', listing_ids: [], detail_id: 'body' },
  ],
  identity_aliases: [{ legacy_id: 'legacy-shared', activity_id: 'shared' }], warnings: [],
};
await mkdir('.generated/site/data', { recursive: true });
await writeFile('.generated/site/data/catalog.json', JSON.stringify(catalog));
console.log('Prepared synthetic CI-only input; no PDF originals or real extracted content were used.');
