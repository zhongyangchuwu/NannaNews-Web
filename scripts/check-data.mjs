import { readFile, readdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCatalog } from '../src/reader.ts';

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
  if (!catalog.issues.length || !catalog.entries.length) throw new Error('No PDF messages were produced; refusing to build an empty publication.');
  const published = await files(publicRoot);
  if (published.length !== 1 || published[0] !== 'data/catalog.json') {
    throw new Error('Only the validated catalog may enter the static data directory; PDF originals and parser evidence must stay local.');
  }
  const summary = {
    issues: catalog.issues.map(({ date, number, filename }) => ({ date, number, filename })),
    entries: catalog.entries.length,
    warnings: catalog.warnings,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const text = JSON.stringify(summary, null, 2).replace(/`/g, '\\u0060');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## PDF extraction summary\n\n\`\`\`json\n${text}\n\`\`\`\n`);
  }
} catch (error) {
  console.error(`Cannot build the PDF reader: ${error.message}`);
  console.error('Prepare local input with: npm run import:pdf -- /path/to/pdf-directory');
  process.exitCode = 1;
}
