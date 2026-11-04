// Synthetic CI bundling input only. Publication has a separate checkout and
// only tracked pdf/ sources, so this catalog is never uploaded or deployed.
import { mkdir, writeFile } from 'node:fs/promises';
const issueId = 'issue-' + 'a'.repeat(24);
const catalog = {
  schema_version: 2,
  issues: [{ id: issueId, date: '2099-01-01', number: 1, title: '合成构建样例', filename: 'synthetic.pdf', sha256: 'a'.repeat(64) }],
  entries: [{
    id: 'entry-' + 'b'.repeat(24), issue_id: issueId, category: '讲座',
    listings: [{ title: '合成消息，仅用于CI构建检查', cutoff: '2099-01-02', cutoff_raw: '01-02', listed_on: '2099-01-01', listed_raw: '01-01', source_urls: ['https://example.org/notice'], page: 1 }],
    detail: { title: '合成消息的本期说明', text: '这不是已发布消息。', fields: [{ label: '讲座时间', value: '1月2日10:00' }, { label: '讲座地点', value: '测试报告厅' }], source_urls: ['https://example.org/notice'], other_urls: [], page: 1 },
  }],
  warnings: [],
};
await mkdir('.generated/site/data', { recursive: true });
await writeFile('.generated/site/data/catalog.json', JSON.stringify(catalog));
console.log('Prepared synthetic CI-only input; no PDF originals or real extracted content were used.');
