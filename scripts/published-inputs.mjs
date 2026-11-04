import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../src/reader.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const masterPath = 'data/catalog.json';
const tracked = execFileSync('git', ['ls-files', '-z', '--', masterPath, 'pdf/'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
if (!tracked.includes(masterPath)) throw new Error('The reviewed canonical master data/catalog.json must be versioned in this repository.');
const info = await lstat(path.join(root, masterPath));
if (info.isSymbolicLink() || !info.isFile()) throw new Error('The public canonical master must be a regular tracked file.');
const bytes = await readFile(path.join(root, masterPath));
const catalog = parseCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
const acceptedSources = new Set(catalog.issues.map(issue => issue.sha256));
const pdfs = tracked.filter(file => /\.pdf$/i.test(file));
for (const file of pdfs) {
  const full = path.join(root, file);
  const source = await lstat(full);
  if (source.isSymbolicLink() || !source.isFile()) throw new Error('Public PDF sources must be regular tracked files.');
  const digest = createHash('sha256').update(await readFile(full)).digest('hex');
  if (!acceptedSources.has(digest)) throw new Error(`Public PDF is absent from the accepted master: ${file}. Import and review its master-data changes in the same PR.`);
}
const hasData = catalog.issues.length > 0 && catalog.activities.length > 0;
console.log(`${pdfs.length} intentionally public PDF source(s); ${catalog.issues.length} accepted publication(s), ${catalog.activities.length} activity identity record(s).`);
if (!hasData) console.log('Content publication is disabled. Private local masters, caches and synthetic fixtures are not publication sources.');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `has_data=${hasData}\n`);
