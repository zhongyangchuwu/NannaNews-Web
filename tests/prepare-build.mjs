// Synthetic CI bundling input only. The publication job uses a separate checkout
// and only tracked pdf/ sources; it never uploads this generated catalog.
import { mkdir, writeFile } from 'node:fs/promises';
const issueId = 'issue-' + 'a'.repeat(24);
const catalog = {
  schema_version: 1,
  issues: [{ id: issueId, date: '2099-01-01', number: 1, title: '合成构建样例', filename: 'synthetic.pdf', sha256: 'a'.repeat(64) }],
  entries: [{ id: 'entry-' + 'b'.repeat(24), issue_id: issueId, title: '合成消息，仅用于CI构建检查', category: '讲座', kind: 'activity', cutoff: '2099-01-02', cutoff_raw: '01-02', listed_on: '2099-01-01', time: '1月2日 10:00', location: '测试报告厅', summary: '这不是已发布消息。', text: '仅验证静态打包，不会作为发布内容。', source_urls: ['https://example.org/notice'], page: 1 }],
  warnings: [],
};
await mkdir('.generated/site/data', { recursive: true });
await writeFile('.generated/site/data/catalog.json', JSON.stringify(catalog));
console.log('Prepared synthetic CI-only input; no PDF originals or real extracted content were used.');
