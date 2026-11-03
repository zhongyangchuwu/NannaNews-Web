import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stageCatalog } from '../scripts/stage-data.ts';

const directories: string[] = [];
const emptyMaster = () => ({ schema_version: 3, issues: [], activities: [], listings: [], details: [], publications: [], identity_aliases: [], warnings: [] });
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nannaweb-stage-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('rejects dangling relations before replacing the last accepted reading snapshot', async () => {
  const directory = await workspace();
  const master = path.join(directory, 'candidate.json');
  const output = path.join(directory, 'reading.json');
  const previous = JSON.stringify(emptyMaster());
  const candidate = JSON.stringify({ ...emptyMaster(), activities: [{ id: 'activity' }],
    publications: [{ activity_id: 'activity', issue_id: 'missing-issue', listing_ids: ['missing-row'], detail_id: null }] });
  await writeFile(master, candidate);
  await writeFile(output, previous);
  await expect(stageCatalog(master, output)).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe(previous);
  expect(await readFile(master, 'utf8')).toBe(candidate);
});

it('refuses to stage through a symbolic master path without touching the accepted output', async () => {
  const directory = await workspace();
  const actual = path.join(directory, 'private-master.json');
  const link = path.join(directory, 'linked-master.json');
  const output = path.join(directory, 'reading.json');
  const original = JSON.stringify(emptyMaster());
  await writeFile(actual, original);
  await symlink(actual, link);
  await writeFile(output, 'previous accepted output');
  await expect(stageCatalog(link, output)).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe('previous accepted output');
  expect(await readFile(actual, 'utf8')).toBe(original);
});

it('never replaces authoritative data with its own generated reading output', async () => {
  const directory = await workspace();
  const master = path.join(directory, 'master.json');
  const original = JSON.stringify(emptyMaster(), null, 2);
  await writeFile(master, original);
  await expect(stageCatalog(master, master)).rejects.toThrow();
  expect(await readFile(master, 'utf8')).toBe(original);
});
