import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 3) {
  console.error('Usage: npm run import:pdf -- /path/to/local/pdf-directory');
  process.exit(2);
}
const input = path.resolve(process.argv[2]);
const localPython = path.join(root, '.venv', 'bin', 'python');
const python = process.env.PYTHON || (existsSync(localPython) ? localPython : 'python3');
const pythonDirectory = path.isAbsolute(python) ? path.dirname(python) : null;
const result = spawnSync(python, [
  '-m', 'nannaweb', 'build', '--input-dir', input,
  '--output', path.join(root, '.generated', 'site', 'data', 'catalog.json'),
  '--cache', path.join(root, '.cache', 'pdf'),
], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, 'src'), PATH: pythonDirectory ? `${pythonDirectory}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH }, stdio: 'inherit' });
if (result.error) {
  console.error(`Cannot start the offline PDF tools: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
