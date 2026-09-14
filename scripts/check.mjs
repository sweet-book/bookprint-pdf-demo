#!/usr/bin/env node
/** npm run check — 타입·스타일·층 규칙·테스트를 순서대로. 앞 단계가 실패하면 멈춘다 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (pkg, rel) => join(ROOT, 'node_modules', pkg, rel);

const TSC = bin('typescript', 'bin/tsc');
const BIOME = bin('@biomejs/biome', 'bin/biome');
const DEPCRUISE = bin('dependency-cruiser', 'bin/dependency-cruise.mjs');
const TSX = bin('tsx', 'dist/cli.mjs');
for (const p of [TSC, BIOME, DEPCRUISE, TSX]) {
  if (!existsSync(p)) {
    console.error(`check: 도구를 찾을 수 없음 — ${p}. npm install 을 먼저 실행하세요.`);
    process.exit(1);
  }
}

const steps = [
  ['1 타입', [TSC, '--noEmit']],
  ['2 스타일', [BIOME, 'check', '.']],
  ['3 층 규칙', [DEPCRUISE, 'src', '--config', '.dependency-cruiser.cjs']],
  ['4 단위', [TSX, '--test', 'tests/unit/**/*.test.ts', 'tests/review/**/*.test.ts']],
];

const t0 = Date.now();
let passed = 0;
for (const [label, args] of steps) {
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\ncheck: FAIL at ${label} (${sec}s) — ${passed}/${steps.length} passed`);
    process.exit(1);
  }
  passed += 1;
  console.log(`check: ${label} ok (${sec}s)`);
}
console.log(
  `\ncheck: ${passed}/${steps.length} passed (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
