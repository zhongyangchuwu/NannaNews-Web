import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const maximum = 1_000_000_000;
let bytes = 0;
let files = 0;
async function measure(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await measure(file);
    else if (entry.isFile()) {
      const { size } = await stat(file);
      bytes += size;
      files++;
    } else throw new Error(`Unsupported Pages resource: ${file}`);
  }
}
await measure(root);
if (bytes > maximum) throw new Error(`Pages publication exceeds ${maximum} bytes: ${bytes}`);
console.log(`Pages publication: ${files} regular files, ${bytes} bytes (limit ${maximum}).`);
