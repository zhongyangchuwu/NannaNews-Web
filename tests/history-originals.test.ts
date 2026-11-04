import { describe, expect, it } from 'vitest';
import { originalUrl, parseOriginals } from '../src/history/originals';

const sha = 'a'.repeat(64);
const ref = 'b'.repeat(40);
const fixture = () => ({
  schema_version: 1, generator: 'nannanews-history-originals-v1', repository: 'zhongyangchuwu/NannaNews-Web', source_ref: ref,
  counts: { documents: 1, html: 0, pdf: 1, bytes: 12 },
  documents: [{ sha256: sha, format: 'pdf', filename: '原刊.pdf', size: 12, kind: 'original', path: 'pdf/原刊.pdf',
    aliases: [{ filename: '另一日期.pdf', filename_date: null, content_date: '2025-01-01', date_status: 'uncertain' }],
    registry_metadata: { claimed_date: null, recorded_issue_date: null, recorded_issue_number: null } }],
});

describe('public original metadata', () => {
  it('preserves aliases and pins encoded view and raw links to the commit', () => {
    const manifest = parseOriginals(fixture());
    expect(manifest.documents[0].aliases[0].date_status).toBe('uncertain');
    expect(originalUrl(manifest, manifest.documents[0])).toBe(`https://github.com/zhongyangchuwu/NannaNews-Web/blob/${ref}/pdf/%E5%8E%9F%E5%88%8A.pdf`);
    expect(originalUrl(manifest, manifest.documents[0], 'raw')).toBe(`https://raw.githubusercontent.com/zhongyangchuwu/NannaNews-Web/${ref}/pdf/%E5%8E%9F%E5%88%8A.pdf`);
  });
  it('rejects unsafe paths, duplicate identities, incorrect totals and private fields', () => {
    const input = fixture();
    const doc = input.documents[0];
    const bad = [
      { ...input, source_ref: 'main' },
      { ...input, repository: 'other/repo' },
      { ...input, counts: { ...input.counts, bytes: 13 } },
      { ...input, documents: [{ ...doc, path: 'pdf/../private.pdf' }] },
      { ...input, documents: [{ ...doc, path: 'pdf/a?x.pdf' }] },
      { ...input, documents: [{ ...doc, path: `history/originals/${'c'.repeat(64)}.pdf` }] },
      { ...input, documents: [doc, doc] },
      { ...input, documents: [{ ...doc, private_path: '/secret' }] },
      { ...input, documents: [{ ...doc, aliases: [{ ...doc.aliases[0], filename: '../x' }] }] },
    ];
    for (const value of bad) expect(() => parseOriginals(value)).toThrow();
  });
});
