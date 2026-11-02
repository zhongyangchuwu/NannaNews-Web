import { execFileSync } from 'node:child_process';
import { lstat, appendFile } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '-z', '--', 'pdf/'], { encoding: 'utf8' })
  .split('\0').filter((file) => /\.pdf$/i.test(file));
for (const file of files) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Published PDF inputs must be regular tracked files.');
}
const hasPdfs = files.length > 0;
console.log(`${files.length} intentionally published PDF input(s).`);
if (!hasPdfs) console.log('Content publication is disabled. Local PDFs and synthetic build fixtures are not publication sources.');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `has_pdfs=${hasPdfs}\n`);
