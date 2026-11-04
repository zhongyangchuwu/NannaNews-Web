import { readFile, readdir, stat, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCatalog } from '../src/reader.ts';
import { parseOriginals } from '../src/history/originals.ts';

const publicRoot = fileURLToPath(new URL('../.generated/site/', import.meta.url));
const catalogPath = path.join(publicRoot, 'data', 'catalog.json');

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Static output must not contain symlinks: ${relative}`);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), `${relative}/`));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unsupported public resource: ${relative}`);
  }
  return result;
}

try {
  const catalog = parseCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
  if (!catalog.issues.length || !catalog.activities.length) throw new Error('No accepted publications were staged; refusing to build an empty publication.');
  const published = await files(publicRoot);
  const originals = parseOriginals(JSON.parse(await readFile(path.join(publicRoot, 'data/history-originals.json'), 'utf8')));
  const source = JSON.parse(await readFile(new URL('../data/history.json', import.meta.url), 'utf8'));
  const resources = JSON.parse(await readFile(path.join(publicRoot, 'history-data/resource-manifest.json'), 'utf8'));
  if (source.schema_version !== 1 || source.generator !== 'nannanews-history-source-v1'
    || resources.schema_version !== 1 || resources.generator !== 'nannanews-history-resources-v1'
    || !/^[0-9a-f]{64}$/.test(source.data_version) || resources.data_version !== source.data_version
    || !isDeepStrictEqual(resources.counts, source.counts) || !Array.isArray(resources.files)) {
    throw new Error('Historical resources do not match the reviewed source configuration.');
  }
  const allowed = new Set(['data/catalog.json', 'data/history-originals.json', 'history-data/resource-manifest.json']);
  const prefix = `versions/${source.data_version}/`;
  let images = 0, pdfs = 0;
  for (const item of resources.files) {
    const virtual = item.source_path;
    const safe = typeof virtual === 'string' && !/[\\\x00-\x1f\x7f?#]/.test(virtual)
      && virtual.split('/').every(part => part && part !== '.' && part !== '..');
    const json = safe && virtual.startsWith(`${prefix}reader-v3/`) && virtual.endsWith('.json');
    const asset = safe && virtual.startsWith(`${prefix}assets/`) && /^[0-9a-f]{64}\.(jpg|png|pdf)$/.test(virtual.slice(`${prefix}assets/`.length));
    const bootstrap = virtual === 'manifest.json';
    if ((!json && !asset && !bootstrap) || item.path !== virtual + (json ? '.gz' : '')
      || item.encoding !== (json ? 'gzip' : 'identity') || !Number.isSafeInteger(item.size) || item.size < 0
      || item.size > 256_000_000 || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error(`Disallowed historical static resource: ${item.path}`);
    }
    const relative = `history-data/${item.path}`;
    if (allowed.has(relative)) throw new Error(`Duplicate static resource: ${relative}`);
    allowed.add(relative);
    const file = path.join(publicRoot, relative);
    if ((await stat(file)).size !== item.size) throw new Error(`Historical resource size mismatch: ${relative}`);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== item.sha256) throw new Error(`Historical resource SHA-256 mismatch: ${relative}`);
    if (asset && /\.(jpg|png)$/.test(virtual)) images++;
    if (asset && virtual.endsWith('.pdf')) pdfs++;
    if (bootstrap && item.sha256 !== resources.source_manifest_sha256) throw new Error('Historical bootstrap digest mismatch.');
  }
  if (published.length !== allowed.size || published.some(file => !allowed.has(file))
    || images !== source.counts.images || pdfs !== source.counts.pdfs || !allowed.has('history-data/manifest.json')) {
    throw new Error('Static output must contain only the complete validated catalogs, history JSON and raster/PDF resources; original HTML stays outside it.');
  }
  const bootstrap = JSON.parse(await readFile(path.join(publicRoot, 'history-data/manifest.json'), 'utf8'));
  if (bootstrap.schema_version !== 3 || bootstrap.generator !== 'nannanews-reader-v3'
    || bootstrap.data_version !== source.data_version || bootstrap.public_facts_only === true
    || !isDeepStrictEqual(bootstrap.counts, source.counts)) throw new Error('Historical bootstrap is incomplete or inconsistent.');
  let staticBytes = 0;
  for (const file of published) staticBytes += (await stat(path.join(publicRoot, file))).size;
  if (staticBytes > 1_000_000_000) throw new Error(`Static data exceeds the Pages publication limit: ${staticBytes}`);
  const explained = new Set(catalog.publications.filter(publication => publication.detail_id !== null).map(publication => publication.activity_id));
  const summary = {
    issues: catalog.issues.map(({ date, number, filename }) => ({ date, number, filename })),
    activities: catalog.activities.length,
    publications: catalog.publications.length,
    table_rows: catalog.listings.length,
    issue_explanations: catalog.details.length,
    activities_without_detail: catalog.activities.length - explained.size,
    matched_list_and_explanation: catalog.publications.filter(publication => publication.listing_ids.length > 0 && publication.detail_id !== null).length,
    identity_aliases: catalog.identity_aliases.length,
    warnings: catalog.warnings,
    history: source.counts,
    originals: originals.counts,
    static_bytes: staticBytes,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const text = JSON.stringify(summary, null, 2).replace(/`/g, '\\u0060');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Accepted master data summary\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
} catch (error) {
  console.error(`Cannot build the PDF reader: ${error.message}`);
  console.error('Stage reviewed data with: npm run stage:data -- /path/to/accepted-catalog.json');
  process.exitCode = 1;
}
