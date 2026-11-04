import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../src/reader.ts';
import { parseOriginals } from '../src/history/originals.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const masterPath = 'data/catalog.json';
const historyPaths = ['data/history.json', 'data/history-originals.json'];
const tracked = execFileSync('git', ['ls-files', '-z', '--', masterPath, ...historyPaths, 'pdf/', 'history/originals/'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
if (!tracked.includes(masterPath)) throw new Error('The reviewed canonical master data/catalog.json must be versioned in this repository.');
const info = await lstat(path.join(root, masterPath));
if (info.isSymbolicLink() || !info.isFile()) throw new Error('The public canonical master must be a regular tracked file.');
const bytes = await readFile(path.join(root, masterPath));
const catalog = parseCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
const acceptedSources = new Set(catalog.issues.map(issue => issue.sha256));
const pdfs = tracked.filter(file => file.startsWith('pdf/') && /\.pdf$/i.test(file));
for (const file of pdfs) {
  const full = path.join(root, file);
  const source = await lstat(full);
  if (source.isSymbolicLink() || !source.isFile()) throw new Error('Public PDF sources must be regular tracked files.');
  const digest = createHash('sha256').update(await readFile(full)).digest('hex');
  if (!acceptedSources.has(digest)) throw new Error(`Public PDF is absent from the accepted master: ${file}. Import and review its master-data changes in the same PR.`);
}
for (const file of historyPaths) {
  if (!tracked.includes(file)) throw new Error(`Reviewed history metadata must be versioned: ${file}`);
  const source = await lstat(path.join(root, file));
  if (!source.isFile() || source.isSymbolicLink()) throw new Error(`History metadata must be a regular file: ${file}`);
}
const originals = parseOriginals(JSON.parse(await readFile(path.join(root, historyPaths[1]), 'utf8')));
const pinned = new Map(execFileSync('git', ['ls-tree', '-r', '-z', originals.source_ref, '--', 'pdf/', 'history/originals/'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean).map(entry => {
    const [header, file] = entry.split('\t');
    const [mode, type, oid] = header.split(' ');
    if (mode !== '100644' || type !== 'blob') throw new Error(`Pinned original must be a regular Git blob: ${file}`);
    return [file, oid];
  }));
const originalPaths = new Set(originals.documents.map(document => document.path));
for (const document of originals.documents) {
  if (!tracked.includes(document.path)) throw new Error(`Original is not tracked: ${document.path}`);
  const source = await lstat(path.join(root, document.path));
  if (!source.isFile() || source.isSymbolicLink()) throw new Error(`Original must be a regular file: ${document.path}`);
  const bytes = await readFile(path.join(root, document.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== document.size || digest !== document.sha256 || pinned.get(document.path) !== oid) {
    throw new Error(`Original bytes do not match the reviewed commit-pinned metadata: ${document.path}`);
  }
}
for (const file of tracked.filter(file => file.startsWith('history/originals/'))) {
  if (!originalPaths.has(file)) throw new Error(`Historical original has no reviewed metadata: ${file}`);
}
console.log(`${originals.counts.documents} commit-pinned historical original(s); ${originals.counts.html} HTML and ${originals.counts.pdf} PDF, deduplicated by SHA-256.`);
const hasData = catalog.issues.length > 0 && catalog.activities.length > 0;
console.log(`${pdfs.length} intentionally public PDF source(s); ${catalog.issues.length} accepted publication(s), ${catalog.activities.length} activity identity record(s).`);
if (!hasData) console.log('Content publication is disabled. Private local masters, caches and synthetic fixtures are not publication sources.');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `has_data=${hasData}\n`);
