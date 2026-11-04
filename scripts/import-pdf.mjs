import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: npm run import:pdf -- /path/to/pdf-directory [--catalog path/to/master.json] [--cache path/to/cache] [--legacy-catalog path/to/v2-catalog.json]';
const args = process.argv.slice(2);
const options = new Map();
if (!args.length || args[0].startsWith('-')) {
  console.error(usage);
  process.exit(2);
}
for (let index = 1; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!['--catalog', '--cache', '--legacy-catalog'].includes(name) || !value || value.startsWith('-') || options.has(name)) {
    console.error(usage);
    process.exit(2);
  }
  options.set(name, path.resolve(value));
}
const input = path.resolve(args[0]);
const catalog = options.get('--catalog') ?? path.join(root, '.local-data', 'catalog.json');
const cache = options.get('--cache') ?? path.join(root, '.cache', 'pdf');
const localPython = path.join(root, '.venv', 'bin', 'python');
const python = process.env.PYTHON || (existsSync(localPython) ? localPython : 'python3');
const pythonDirectory = path.isAbsolute(python) ? path.dirname(python) : null;
const command = ['-m', 'nannaweb', 'import', '--input-dir', input, '--catalog', catalog, '--cache', cache];
if (options.has('--legacy-catalog')) command.push('--legacy-catalog', options.get('--legacy-catalog'));
const imported = spawnSync(python, command, {
  cwd: root,
  env: { ...process.env, PYTHONPATH: path.join(root, 'src'), PATH: pythonDirectory ? `${pythonDirectory}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH },
  stdio: 'inherit',
});
if (imported.error) {
  console.error(`Cannot start the offline PDF importer: ${imported.error.message}`);
  process.exit(1);
}
if (imported.status !== 0) process.exit(imported.status ?? 1);
const staged = spawnSync(process.execPath, ['--experimental-strip-types', path.join(root, 'scripts', 'stage-data.ts'), catalog], { cwd: root, stdio: 'inherit' });
if (staged.error) {
  console.error(`The master was imported, but its reading export could not be started: ${staged.error.message}`);
  process.exit(1);
}
process.exit(staged.status ?? 1);
