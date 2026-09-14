import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openPdf, PdfPrecheckError } from '../../src/flow/index.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bp-pdf-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('사전 검사 통과 — 크기·이름·스트림', async () => {
  const p = join(dir, 'ok.pdf');
  await writeFile(p, '%PDF-1.4\n%fake\n');
  const f = await openPdf(p);
  assert.equal(f.filename, 'ok.pdf');
  assert.equal(f.size, 15);
  let n = 0;
  for await (const c of f.open()) n += c.byteLength;
  assert.equal(n, 15);
});

test('시그니처가 없으면 서버에 보내지 않는다', async () => {
  const p = join(dir, 'not.pdf');
  await writeFile(p, 'hello world');
  await assert.rejects(
    openPdf(p),
    (e: unknown) => e instanceof PdfPrecheckError && e.reason === 'not-pdf',
  );
});

test('없는 파일·디렉터리', async () => {
  await assert.rejects(
    openPdf(join(dir, 'nope.pdf')),
    (e: unknown) => e instanceof PdfPrecheckError && e.reason === 'not-found',
  );
  await assert.rejects(
    openPdf(dir),
    (e: unknown) => e instanceof PdfPrecheckError && e.reason === 'not-a-file',
  );
});

test('동봉 샘플은 전부 사전 검사를 통과한다', async () => {
  for (const name of [
    'SQUAREBOOK_HC_cover_24p.pdf',
    'SQUAREBOOK_HC_inner_24p.pdf',
    'PHOTOBOOK_A4_SC_cover_24p.pdf',
    'PHOTOBOOK_A4_SC_inner_24p.pdf',
  ]) {
    const f = await openPdf(join('fixtures', name));
    assert.ok(f.size > 0, name);
  }
});
