import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOrder,
  estimate,
  finalize,
  getEstimate,
  isReplaceLocked,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  nextStep,
  parseShipping,
  runFlow,
  StepFailed,
} from '../../src/flow/index.js';
import { fixture, networkFailure, scriptedFetch, TEST_KEY, testClient } from '../helpers.js';

class MemoryStore implements JobStore {
  saves = 0;
  async get(): Promise<JobState | null> {
    return null;
  }
  async save(): Promise<void> {
    this.saves += 1;
  }
  async list(): Promise<JobSummary[]> {
    return [];
  }
}

let seq = 0;
const uuid = () => `uuid-${++seq}`;
const now = () => new Date('2026-09-08T03:00:00Z');
const shipping = {
  recipientName: '홍길동',
  recipientPhone: '010-0000-0000',
  postalCode: '06134',
  address1: '서울특별시 강남구 테헤란로 100',
};

/** 업로드까지 끝난 작업 — 최종화부터 시작할 수 있게 */
function uploadedJob(extra: Partial<JobState['input']> = {}): JobState {
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', shipping, ...extra },
    { env: 'sandbox', now, uuid },
  );
  job.bookUid = 'bk_7H7BF7a6g3rU';
  for (const s of ['createBook', 'uploadCover', 'uploadContents'] as const)
    job.steps[s].status = 'DONE';
  return job;
}

const deps = (fetchImpl: typeof fetch) => ({
  client: testClient(fetchImpl),
  store: new MemoryStore(),
  now,
});

// ---------------------------------------------------------------- finalize

test('finalize — 빈 POST 에 Content-Length: 0 + 멱등 키. 201 created → DONE', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('finalize_201.json').raw },
  ]);
  const job = uploadedJob();
  await finalize(job, deps(fetchImpl));
  const req = requests[0];
  assert.ok(req);
  assert.equal(req.method, 'POST');
  assert.match(req.url, /\/books\/bk_7H7BF7a6g3rU\/finalization$/);
  assert.equal(req.body, null, '본문 없음');
  assert.equal(req.headers['Content-Length'], '0', '없으면 IIS 411');
  assert.equal(req.headers['Idempotency-Key'], job.steps.finalize.idempotencyKey);
  assert.equal(job.steps.finalize.status, 'DONE');
  assert.equal(job.steps.finalize.detail?.result, 'created');
});

test('finalize — 이미 최종화된 책은 200 updated. 역시 DONE (응답 유실 뒤 재실행의 정상 경로)', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 200, body: fixture('finalize_again_200.json').raw },
  ]);
  const job = uploadedJob();
  await finalize(job, deps(fetchImpl));
  assert.equal(job.steps.finalize.status, 'DONE');
  assert.equal(job.steps.finalize.detail?.result, 'updated');
});

test('finalize — 업로드가 안 된 책은 400 ERR_FINALIZE_PREREQ_UNMET → FAILED, fieldErrors 둘 다 보존', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 400, body: fixture('finalize_prereq_400.json').raw },
  ]);
  const job = uploadedJob();
  await assert.rejects(finalize(job, deps(fetchImpl)), StepFailed);
  assert.equal(job.steps.finalize.status, 'FAILED');
  assert.equal(job.steps.finalize.error?.errorCode, 'ERR_FINALIZE_PREREQ_UNMET');
  assert.deepEqual(
    job.steps.finalize.error?.fieldErrors.map((f) => f.field),
    ['coverPdf', 'contentsPdf'],
  );
});

test('finalize — 응답 유실은 UNKNOWN. 재실행은 같은 키로 보내고 재현(replayed) 을 기록한다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    networkFailure,
    networkFailure,
    networkFailure,
    networkFailure,
    {
      status: 201,
      body: fixture('finalize_201.json').raw,
      headers: { 'X-Idempotent-Replayed': 'true' },
    },
  ]);
  const job = uploadedJob();
  const d = deps(fetchImpl);
  await assert.rejects(finalize(job, d), StepFailed);
  assert.equal(job.steps.finalize.status, 'UNKNOWN');
  const key = job.steps.finalize.idempotencyKey;
  await finalize(job, d);
  assert.equal(job.steps.finalize.status, 'DONE');
  assert.equal(job.steps.finalize.idempotencyKey, key, 'UNKNOWN 재실행은 같은 키');
  assert.equal(job.steps.finalize.replayed, true);
  assert.ok(requests.every((r) => r.headers['Idempotency-Key'] === key));
});

// ---------------------------------------------------------------- estimate

test('estimate — items[{bookUid, quantity}] 를 보내고 숫자를 detail 에 남긴다. 멱등 키 없음', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('estimate_200.json').raw },
  ]);
  const job = uploadedJob();
  job.steps.finalize.status = 'DONE';
  await estimate(job, deps(fetchImpl));
  assert.equal(requests[0]?.body, '{"items":[{"bookUid":"bk_7H7BF7a6g3rU","quantity":1}]}');
  assert.equal(requests[0]?.headers['Idempotency-Key'], undefined);
  assert.equal(job.steps.estimate.status, 'DONE');
  const e = getEstimate(job);
  assert.ok(e);
  assert.equal(e.totalAmount, 15327);
  assert.equal(e.paidCreditAmount, 16850, 'VAT 포함 10원 절사');
  assert.equal(e.creditBalance, 99000);
  assert.equal(e.creditSufficient, true);
});

test('estimate — creditSufficient=false 면 FAILED 로 멈추고 주문은 부르지 않는다. 402 와 같은 코드·data', async () => {
  const short = fixture('estimate_200.json')
    .raw.replace('"creditSufficient":true', '"creditSufficient":false')
    .replace('"creditBalance":99000.00', '"creditBalance":10000.00');
  const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: short }]);
  const job = uploadedJob();
  job.steps.finalize.status = 'DONE';
  await assert.rejects(runFlow(job, deps(fetchImpl)), StepFailed);
  assert.equal(requests.length, 1, '견적 한 번뿐. POST /orders 없음');
  assert.equal(job.steps.estimate.status, 'FAILED');
  assert.equal(job.steps.estimate.error?.errorCode, 'ERR_INSUFFICIENT_CREDIT');
  assert.deepEqual(job.steps.estimate.error?.data, {
    required: 16850,
    balance: 10000,
    currency: 'KRW',
  });
  assert.equal(getEstimate(job)?.creditSufficient, false, '숫자는 남는다 — 부족액 표시용');
  assert.equal(job.steps.createOrder.status, 'PENDING');
  // 기록: 200 성공 한 줄 + LOCAL 한 줄
  assert.equal(job.log.length, 2);
  assert.equal(job.log[0]?.response?.status, 200);
  assert.equal(job.log[1]?.request.method, 'LOCAL');
});

test('estimate — DRAFT 책은 400 → FAILED', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 400, body: fixture('estimate_draft_400.json').raw },
  ]);
  const job = uploadedJob();
  await assert.rejects(estimate(job, deps(fetchImpl)), StepFailed);
  assert.equal(job.steps.estimate.error?.errorCode, 'ERR_VALIDATION_FAILED');
  assert.match(job.steps.estimate.error?.errors[0] ?? '', /FINALIZED 상태가 아닙니다/);
});

// ---------------------------------------------------------------- createOrder

test('createOrder — items + shipping + externalRef(작업 id) + 멱등 키. 201 → orderUid, 교체 잠금', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  const job = uploadedJob({ quantity: 2 });
  job.steps.finalize.status = 'DONE';
  job.steps.estimate.status = 'DONE';
  assert.equal(isReplaceLocked(job), false);
  await createOrder(job, deps(fetchImpl));
  const req = requests[0];
  assert.ok(req);
  assert.match(req.url, /\/orders$/);
  assert.equal(req.headers['Idempotency-Key'], job.steps.createOrder.idempotencyKey);
  const body = JSON.parse(req.body ?? '{}');
  assert.deepEqual(body.items, [{ bookUid: 'bk_7H7BF7a6g3rU', quantity: 2 }]);
  assert.deepEqual(body.shipping, shipping);
  assert.equal(body.externalRef, job.id);
  assert.equal(job.orderUid, 'or_2CdbvnnOtRYN');
  assert.equal(job.steps.createOrder.status, 'DONE');
  assert.equal(job.steps.createOrder.detail?.orderStatus, 'PDF_READY');
  assert.equal(isReplaceLocked(job), true, '주문 뒤 PDF 교체는 앱이 잠근다');
  assert.ok(!JSON.stringify(job).includes(TEST_KEY));
});

test('createOrder — 배송지가 없으면 서버를 부르지 않고 FAILED (LOCAL)', async () => {
  const { fetchImpl, requests } = scriptedFetch([]);
  const job = uploadedJob();
  delete job.input.shipping;
  await assert.rejects(createOrder(job, deps(fetchImpl)), StepFailed);
  assert.equal(requests.length, 0);
  assert.equal(job.steps.createOrder.status, 'FAILED');
  assert.equal(job.steps.createOrder.error?.errorCode, 'ERR_SHIPPING_MISSING');
});

test('createOrder — 402 ERR_INSUFFICIENT_CREDIT (경합) → FAILED, data{required,balance} 보존, 재시도 없음', async () => {
  const body = fixture('order_insufficient_credit_402.json').raw;
  const { fetchImpl, requests } = scriptedFetch([{ status: 402, body }]);
  const job = uploadedJob();
  await assert.rejects(createOrder(job, deps(fetchImpl)), StepFailed);
  assert.equal(requests.length, 1);
  assert.equal(job.steps.createOrder.status, 'FAILED');
  assert.equal(job.steps.createOrder.error?.status, 402);
  assert.deepEqual(job.steps.createOrder.error?.data, {
    required: 113870,
    balance: 99000,
    currency: 'KRW',
  });
  assert.equal(job.orderUid, null);
});

test('createOrder — 응답 유실 뒤 재실행은 같은 키. 서버가 받았었다면 201 + replayed 로 같은 주문', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    networkFailure,
    networkFailure,
    networkFailure,
    networkFailure,
    {
      status: 201,
      body: fixture('order_create_201.json').raw,
      headers: { 'X-Idempotent-Replayed': 'true', 'X-Idempotent-Key': 'echo' },
    },
  ]);
  const job = uploadedJob();
  const d = deps(fetchImpl);
  await assert.rejects(createOrder(job, d), StepFailed);
  assert.equal(job.steps.createOrder.status, 'UNKNOWN');
  const key = job.steps.createOrder.idempotencyKey;
  await createOrder(job, d);
  assert.equal(job.orderUid, 'or_2CdbvnnOtRYN');
  assert.equal(job.steps.createOrder.replayed, true);
  assert.ok(
    requests.every((r) => r.headers['Idempotency-Key'] === key),
    '5번 전부 같은 키',
  );
});

// ---------------------------------------------------------------- 전체 흐름

test('runFlow — 최종화 → 견적 → 주문까지 한 번에. until:estimate 로 주문 직전에 멈출 수 있다 (--dry-run)', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('finalize_201.json').raw },
    { status: 200, body: fixture('estimate_200.json').raw },
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  const job = uploadedJob();
  const d = deps(fetchImpl);
  await runFlow(job, d, { until: 'estimate' });
  assert.equal(nextStep(job), 'createOrder');
  assert.equal(requests.length, 2, '주문은 아직');
  await runFlow(job, d);
  assert.equal(nextStep(job), null);
  assert.equal(job.orderUid, 'or_2CdbvnnOtRYN');
  assert.equal(requests.length, 3);
});

// ---------------------------------------------------------------- shipping

test('parseShipping — 필수 4개가 비어 있으면 거부, 선택 2개는 있을 때만, 공백은 다듬는다', () => {
  assert.throws(() => parseShipping(null), /객체/);
  assert.throws(
    () => parseShipping({ recipientName: '홍' }),
    /recipientPhone, postalCode, address1/,
  );
  assert.throws(() => parseShipping({ ...shipping, postalCode: '  ' }), /postalCode/);
  const ok = parseShipping({ ...shipping, address2: ' 1층 ', memo: '' });
  assert.deepEqual(ok.shipping, { ...shipping, address2: '1층' });
});
