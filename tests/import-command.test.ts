import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('requires an explicit PDF input instead of assuming the public upload directory', () => {
  const command = fileURLToPath(new URL('../scripts/import-pdf.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command], { encoding: 'utf8', timeout: 3000 });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Usage: npm run import:pdf --');
});
