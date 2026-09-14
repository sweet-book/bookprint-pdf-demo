import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookSpec } from '../../src/bookprint/index.js';
import { printSpecs } from '../../src/cli/render.js';

/** 터미널이 그리는 칸 수 — 이 테스트의 기준자 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x2e80 && c <= 0xa4cf) ? 2 : 1;
  }
  return w;
}

function captured(fn: () => void): string[] {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = log;
  }
  return lines;
}

const SPECS: BookSpec[] = [
  {
    bookSpecUid: 'PHOTOBOOK_A4_SC',
    coverType: 'Softcover',
    innerTrimWidthMm: 210,
    innerTrimHeightMm: 297,
    pageMin: 24,
    pageMax: 200,
    pageIncrement: 2,
    priceBase: 12400,
    priceCurrency: 'KRW',
  } as BookSpec,
  {
    bookSpecUid: 'SQUAREBOOK_HC',
    coverType: 'Hardcover',
    innerTrimWidthMm: 243,
    innerTrimHeightMm: 248,
    pageMin: 24,
    pageMax: 130,
    pageIncrement: 2,
    priceBase: 12600,
    priceCurrency: 'KRW',
  } as BookSpec,
];

test('판형 표의 열이 한글 머리글과 어긋나지 않는다', () => {
  const lines = captured(() => {
    printSpecs(SPECS);
  });
  assert.equal(lines.length, 3, '머리글 + 판형 2줄');

  // 마지막 열(기본가)이 시작하는 칸이 세 줄 모두 같아야 한다
  const priceColumn = (line: string): number => {
    const at = line.lastIndexOf('  ');
    return width(line.slice(0, at));
  };
  const header = lines[0] as string;
  for (const row of lines.slice(1)) {
    const h = width(header.replace(/기본가\s*$/, ''));
    const r = width((row as string).replace(/[\d,]+ KRW\s*$/, ''));
    assert.equal(r, h, `열 시작 칸이 다르다\n  머리글 ${h}칸\n  값     ${r}칸\n  ${row}`);
  }
  assert.ok(priceColumn(header) > 0);
});

test('열 폭은 가장 긴 값을 담는다 — 넘쳐서 다음 열을 밀지 않는다', () => {
  const lines = captured(() => {
    printSpecs(SPECS);
  });
  // "24~200 (2p 단위)" 는 16칸이다
  const starts = lines.map((l) => width(l.replace(/[\d,]+ KRW\s*$|기본가\s*$/, '')));
  assert.equal(new Set(starts).size, 1, `줄마다 마지막 열 시작이 다르다: ${starts.join(', ')}`);
});
