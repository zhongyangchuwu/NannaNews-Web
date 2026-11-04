import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../src/reader.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultMaster = path.join(root, 'data', 'catalog.json');
const defaultOutput = path.join(root, '.generated', 'site', 'data', 'catalog.json');

async function prepareDirectory(directory: string) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Staging directory is not a regular directory: ${current}`);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
}

/** Copy an accepted master for reading; never import, allocate IDs or rewrite it. */
export async function stageCatalog(masterPath: string, outputPath = defaultOutput) {
  const source = path.resolve(masterPath);
  const output = path.resolve(outputPath);
  if (source === output) throw new Error('Master data and generated reading output must be separate files.');
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Canonical master data must be a regular file, not a symbolic link.');
  const bytes = await readFile(source);
  const catalog = parseCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  await prepareDirectory(path.dirname(output));
  const temporary = path.join(path.dirname(output), `.catalog-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { issues: catalog.issues.length, activities: catalog.activities.length,
    publications: catalog.publications.length, table_rows: catalog.listings.length,
    issue_explanations: catalog.details.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0]?.startsWith('-')) {
    console.error('Usage: npm run stage:data -- [path/to/accepted-catalog.json]');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await stageCatalog(args[0] ?? defaultMaster)));
    } catch (error) {
      console.error(`Cannot stage canonical master data: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
