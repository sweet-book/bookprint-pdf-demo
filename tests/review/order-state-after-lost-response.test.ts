import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOrder,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  runFlow,
  type Shipping,
  StepFailed,
} from '../../src/flow/index.js';
import { fixture, scriptedFetch, testClient } from '../helpers.js';

class MemoryStore implements JobStore {
  private m = new Map<string, string>();
  async get(id: string): Promise<JobState | null> {
    const s = this.m.get(id);
    return s ? (JSON.parse(s) as JobState) : null;
  }
  async save(job: JobState): Promise<void> {
    this.m.set(job.id, JSON.stringify(job));
  }
  async list(): Promise<JobSummary[]> {
    return [];
  }
}

const now = () => new Date('2026-09-11T03:00:00Z');
const shipping: Shipping = {
  recipientName: '홍길동',
  recipientPhone: '01012345678',
  postalCode: '06236',
  address1: '서울시',
};

/** 견적까지 끝나 주문만 남은 작업 */
function orderJob(): JobState {
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', quantity: 1, shipping },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  for (const s of ['createBook', 'uploadCover', 'uploadContents', 'finalize', 'estimate'] as const)
    job.steps[s].status = 'DONE';
  job.steps.estimate.finishedAt = now().toISOString();
  return job;
}

const mismatch = JSON.stringify({
  success: false,
  message: '멱등 키가 다른 요청 본문에 이미 사용되었습니다',
  data: null,
  errorCode: 'ERR_IDEMPOTENCY_KEY_MISMATCH',
  errors: [],
  fieldErrors: [],
});

test('UNKNOWN 뒤의 422 키 불일치로 새 키를 만들지 않는다 — 만들면 두 번째 주문이 생긴다', async () => {
  const job = orderJob();
  job.steps.createOrder.status = 'UNKNOWN'; // 응답 유실. 서버에는 이 키로 주문이 있다
  const key = job.steps.createOrder.idempotencyKey;
  const store = new MemoryStore();

  // ① 그 사이 배송지를 고친 채 재전송 → 서버는 키가 원 본문에 묶여 있어 422
  const first = scriptedFetch([{ status: 422, body: mismatch }]);
  await assert.rejects(
    createOrder(job, { client: testClient(first.fetchImpl), store, now }),
    StepFailed,
  );
  assert.notEqual(
    job.steps.createOrder.status,
    'FAILED',
    'UNKNOWN 뒤의 422 는 "서버가 처리하지 않았다" 가 아니다 — 원 요청은 처리됐다',
  );

  // ② 다음 재개
  const second = scriptedFetch([{ status: 201, body: fixture('order_create_201.json').raw }]);
  await createOrder(job, { client: testClient(second.fetchImpl), store, now }).catch(
    () => undefined,
  );
  assert.equal(
    second.requests[0]?.headers['Idempotency-Key'],
    key,
    '새 키로 보내면 서버에 주문이 둘이 되고 충전금이 두 번 빠진다',
  );
});

test('201 을 받고 본문을 읽다 연결이 끊기면 UNKNOWN 이다 — 서버에는 주문이 생겼다', async () => {
  const job = orderJob();
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"success":tr'));
        c.error(new TypeError('terminated'));
      },
    });
    return new Response(body, {
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;
  await assert.rejects(
    createOrder(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    StepFailed,
  );
  assert.equal(
    job.steps.createOrder.status,
    'UNKNOWN',
    'FAILED 로 두면 교체 잠금이 풀리고 "입력을 고쳐 다시 실행하라" 는 안내가 나간다',
  );
});

test('2xx 인데 본문을 해석하지 못하면(프록시가 끼운 HTML 등) UNKNOWN 이다', async () => {
  const job = orderJob();
  const { fetchImpl } = scriptedFetch([
    { status: 201, body: '<html><body>OK</body></html>', contentType: 'text/html' },
  ]);
  await assert.rejects(
    createOrder(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    StepFailed,
  );
  assert.equal(job.steps.createOrder.status, 'UNKNOWN', '서버는 2xx 로 받았다고 했다');
});

test('주문이 UNKNOWN 이면 견적이 낡았어도 견적부터 다시 뽑지 않고 같은 키로 재전송한다', async () => {
  const job = orderJob();
  job.steps.createOrder.status = 'UNKNOWN';
  // 1시간 전 견적 — TTL(10분)을 넘었다
  job.steps.estimate.finishedAt = '2026-09-11T02:00:00.000Z';
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  await runFlow(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }).catch(
    () => undefined,
  );
  assert.ok(
    requests[0]?.url.endsWith('/orders'),
    `첫 요청은 주문 재전송이어야 한다. 실제: ${requests[0]?.method} ${requests[0]?.url}`,
  );
  assert.equal(
    job.steps.estimate.status,
    'DONE',
    '견적을 되돌리면 줄어든 잔액으로 "잔액 부족" 과 충전 안내가 나간다',
  );
});
