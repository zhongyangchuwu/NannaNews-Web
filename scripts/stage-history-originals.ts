import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOriginals } from '../src/history/originals.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'data/history-originals.json');
const directory = path.join(root, '.generated/site/data');
const output = path.join(directory, 'history-originals.json');
const info = await lstat(source);
if (info.isSymbolicLink() || !info.isFile()) throw new Error('Reviewed original metadata must be a regular file.');
const bytes = await readFile(source);
const originals = parseOriginals(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
for (const segment of ['.generated', '.generated/site', '.generated/site/data']) {
  const target = path.join(root, segment);
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Staging directory must not be a symlink: ${segment}`);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    await mkdir(target);
  }
}
const temporary = path.join(directory, `.history-originals-${randomUUID()}.tmp`);
try {
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, output);
} finally {
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
console.log(`Staged ${originals.counts.documents} original-document metadata records; original HTML/PDF bytes remain outside static output.`);
