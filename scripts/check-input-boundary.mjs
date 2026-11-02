import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const violations = tracked.filter((file) =>
  /(^|\/)(?:\.generated|\.cache|local-pdf|dist|\.venv|node_modules)(?:\/|$)/.test(file)
  || /(^|\/)\.env(?:\.|$)/.test(file)
  || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(file)
  || (/\.pdf$/i.test(file) && !file.startsWith('pdf/'))
);
if (violations.length) {
  console.error('Local/private inputs must not be committed:\n' + violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Tracked source boundary verified. Only intentionally published PDFs may live under pdf/.');
}
