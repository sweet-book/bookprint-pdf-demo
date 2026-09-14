import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
  isRetryable,
  parseRetryAfter,
} from '../../src/bookprint/index.js';

const base = { attempt: 1, elapsedMs: 0, retryAfterSec: null, random: () => 0.5 };

test('화이트리스트 — 429·500 INTERNAL·멱등 락 409·응답 없음만 재시도', () => {
  assert.equal(isRetryable(null, null), true);
  assert.equal(isRetryable(429, 'ERR_TOO_MANY_REQUESTS'), true);
  assert.equal(isRetryable(500, 'ERR_INTERNAL_ERROR'), true);
  assert.equal(isRetryable(500, 'ERR_PDF_FILE_MISSING'), false);
  assert.equal(isRetryable(409, null), true);
  assert.equal(isRetryable(409, 'ERR_CONFLICT'), false);
  assert.equal(isRetryable(400, 'ERR_VALIDATION_FAILED'), false);
  assert.equal(isRetryable(501, 'ERR_SANDBOX_UNSUPPORTED'), false);
  assert.equal(isRetryable(422, 'ERR_IDEMPOTENCY_KEY_MISMATCH'), false);
});

test('백오프 — 1·2·4·8초에 ±20% jitter, 상한 30초', () => {
  const d1 = decideRetry({ ...base, attempt: 1, status: 500, errorCode: 'ERR_INTERNAL_ERROR' });
  assert.ok(d1.retry && d1.delayMs === 1000);
  const d3 = decideRetry({ ...base, attempt: 3, status: 500, errorCode: 'ERR_INTERNAL_ERROR' });
  assert.ok(d3.retry && d3.delayMs === 4000);
  const lo = decideRetry({ ...base, attempt: 1, status: 429, errorCode: null, random: () => 0 });
  assert.ok(lo.retry && lo.delayMs === 800);
  const hi = decideRetry({ ...base, attempt: 1, status: 429, errorCode: null, random: () => 1 });
  assert.ok(hi.retry && hi.delayMs === 1200);
});

test('Retry-After 는 그대로 쓴다 — 줄이지 않는다', () => {
  const d = decideRetry({ ...base, status: 429, errorCode: null, retryAfterSec: 90 });
  assert.ok(d.retry && d.delayMs === 90_000 && d.reason === 'Retry-After');
});

test('남은 예산을 넘는 대기는 하지 않고 "재개" 로 넘긴다', () => {
  const d = decideRetry({ ...base, status: 429, errorCode: null, retryAfterSec: 200 });
  assert.equal(d.retry, false);
  assert.match(d.reason, /budget/);
  const d2 = decideRetry({
    ...base,
    status: 500,
    errorCode: 'ERR_INTERNAL_ERROR',
    elapsedMs: DEFAULT_RETRY_POLICY.budgetMs - 100,
  });
  assert.equal(d2.retry, false);
});

test('최대 시도 수', () => {
  const d = decideRetry({
    ...base,
    attempt: DEFAULT_RETRY_POLICY.maxAttempts,
    status: 429,
    errorCode: null,
  });
  assert.equal(d.retry, false);
  assert.match(d.reason, /max attempts/);
});

test('parseRetryAfter — 초·HTTP-date·잘못된 값', () => {
  assert.equal(parseRetryAfter('60'), 60);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('garbage'), null);
  const now = Date.parse('2026-09-08T00:00:00Z');
  assert.equal(
    parseRetryAfter('Tue, 08 Sep 2026 00:00:30 GMT', () => now),
    30,
  );
});
