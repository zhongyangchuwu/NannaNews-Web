import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const violations = tracked.filter((file) =>
  /(^|\/)(?:\.generated|\.cache|\.local-data|local-pdf|dist|\.venv|node_modules)(?:\/|$)/.test(file)
  || /(^|\/)\.env(?:\.|$)/.test(file)
  || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(file)
  || (/\.pdf$/i.test(file) && !file.startsWith('pdf/'))
);
if (violations.length) {
  console.error('Local/private data must not be committed:\n' + violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Tracked data boundary verified. Only reviewed public master data and explicitly public PDFs may be versioned.');
}
