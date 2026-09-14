import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BookPrintNetworkError } from '../../src/bookprint/index.js';
import {
  createBook,
  createOrder,
  FlowRuleError,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  replacePdf,
  runFlow,
  type Shipping,
  StepFailed,
  supplyNewPdf,
  uploadCover,
} from '../../src/flow/index.js';
import { fixture, networkFailure, scriptedFetch, testClient } from '../helpers.js';

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

const now = () => new Date('2026-09-10T03:00:00Z');
const shipping: Shipping = {
  recipientName: '홍길동',
  recipientPhone: '01012345678',
  postalCode: '06236',
  address1: '서울시',
};

async function onePagePdf(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bp-skill-'));
  const p = join(dir, name);
  await writeFile(
    p,
    '%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >>\n<< /Type /Page >>\n%%EOF',
    'latin1',
  );
  return p;
}

function orderJob(): JobState {
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', quantity: 1, shipping },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  for (const s of ['createBook', 'uploadCover', 'uploadContents', 'finalize', 'estimate'] as const)
    job.steps[s].status = 'DONE';
  return job;
}

const envelope = (_status: number, errorCode: string | null, message = 'x'): string =>
  JSON.stringify({ success: false, message, data: null, errorCode, errors: [], fieldErrors: [] });

test('UNKNOWN 주문을 재전송했다가 503 을 받아도 UNKNOWN 이다 — 교체 잠금과 키가 유지된다', async () => {
  const job = orderJob();
  job.steps.createOrder.status = 'UNKNOWN'; // 응답 유실. 서버에 주문이 있을 수 있다
  const key = job.steps.createOrder.idempotencyKey;
  const { fetchImpl } = scriptedFetch([
    { status: 503, body: envelope(503, 'ERR_SERVICE_UNAVAILABLE') },
  ]);
  await assert.rejects(
    createOrder(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    StepFailed,
  );
  assert.equal(
    job.steps.createOrder.status,
    'UNKNOWN',
    '서버 오류가 "응답 유실" 사실을 지우면 안 된다',
  );
  assert.equal(job.steps.createOrder.idempotencyKey, key);
});

test('교체 PUT 응답 유실 뒤 재개 — 고친 파일이 서버에 도달한다 (probe present 로 DONE 처리 금지)', async () => {
  const fixed = await onePagePdf('fixed-cover.pdf');
  const old = await onePagePdf('old-cover.pdf');
  const job = orderJob();
  job.steps.estimate.status = 'PENDING';
  job.steps.finalize.status = 'PENDING';
  job.input.coverPath = old;
  // ① 교체 PUT → 응답 유실
  const lost = scriptedFetch([networkFailure]);
  const deps1 = { client: testClient(lost.fetchImpl), store: new MemoryStore(), now };
  await assert.rejects(supplyNewPdf(job, deps1, 'cover', fixed), StepFailed);
  assert.equal(job.steps.uploadCover.status, 'UNKNOWN');
  // ② 재개 — 서버에는 옛 표지가 있다(probe 200)
  const again = scriptedFetch([
    { status: 200, body: '{"success":true,"message":"ok","data":null}' },
    { status: 200, body: fixture('cover_put_200.json').raw },
  ]);
  await uploadCover(job, { client: testClient(again.fetchImpl), store: new MemoryStore(), now });
  const uploads = again.requests.filter((r) => r.method !== 'GET');
  assert.equal(
    uploads.length,
    1,
    `고친 파일 업로드가 나가야 한다. 실제 요청: ${again.requests.map((r) => r.method).join(',')}`,
  );
  assert.equal(job.steps.uploadCover.status, 'DONE');
  assert.equal(job.input.coverPath, fixed, '작업 파일이 고친 경로를 가리켜야 한다');
});

test('409(락) 뒤 재시도 대기 중 Ctrl+C — 주문은 UNKNOWN 이다, FAILED 가 아니다', async () => {
  const job = orderJob();
  const controller = new AbortController();
  const { fetchImpl } = scriptedFetch([{ status: 409, body: envelope(409, null, 'processing') }]);
  const sleep = async (): Promise<void> => {
    controller.abort(new Error('취소'));
  };
  const deps = {
    client: testClient(fetchImpl, { sleep }),
    store: new MemoryStore(),
    now,
    signal: controller.signal,
  };
  await assert.rejects(createOrder(job, deps), StepFailed);
  assert.equal(
    job.steps.createOrder.status,
    'UNKNOWN',
    '서버가 그 키를 처리 중일 수 있다 — 취소는 UNKNOWN',
  );
});

test('idempotencyKey 속성이 없는(undefined) 주문 단계는 보내기 전에 거부한다', async () => {
  const job = orderJob();
  delete (job.steps.createOrder as { idempotencyKey?: string | null }).idempotencyKey; // 구 스키마 작업 파일
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  await assert.rejects(
    createOrder(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    (e: unknown) => e instanceof FlowRuleError && e.errorCode === 'ERR_IDEMPOTENCY_KEY_MISSING',
  );
  assert.equal(requests.length, 0, '키 없이 POST /orders 가 나갔다');
});

test('시작 전에 이미 abort 된 신호 — 요청이 안 나갔으니 UNKNOWN 으로 기록하지 않는다', async () => {
  const controller = new AbortController();
  controller.abort(new Error('프롬프트에서 취소'));
  // 실제 fetch 처럼 — 이미 abort 된 신호면 보내지 않고 AbortError 로 거부한다
  let sent = 0;
  const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    sent += 1;
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  await assert.rejects(
    createBook(job, {
      client: testClient(fetchImpl),
      store: new MemoryStore(),
      now,
      signal: controller.signal,
    }),
  );
  assert.equal(sent, 0);
  assert.notEqual(
    job.steps.createBook.status,
    'UNKNOWN',
    '나가지도 않은 요청을 "응답 유실" 로 적었다',
  );
});

test('replacePdf — 새 로컬 파일이 없으면 DONE 이던 업로드가 FAILED 로 바뀌지 않는다', async () => {
  const job = orderJob();
  job.steps.estimate.status = 'PENDING';
  job.steps.finalize.status = 'PENDING';
  job.input.coverPath = 'old-cover.pdf';
  const { fetchImpl, requests } = scriptedFetch([]);
  await assert.rejects(
    replacePdf(
      job,
      { client: testClient(fetchImpl), store: new MemoryStore(), now },
      'cover',
      join(tmpdir(), 'no-such-file.pdf'),
    ),
  );
  assert.equal(requests.length, 0);
  assert.equal(job.steps.uploadCover.status, 'DONE', '서버의 옛 표지는 그대로 유효하다');
});

test('견적이 DONE 인 작업을 재개하면 주문 전에 견적을 다시 뽑는다', async () => {
  const job = orderJob(); // estimate DONE, createOrder PENDING
  job.steps.estimate.detail = { creditBalance: 99000, paidCreditAmount: 16850 };
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('estimate_200.json').raw },
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  await runFlow(job, { client: testClient(fetchImpl), store: new MemoryStore(), now });
  assert.ok(
    requests[0]?.url.endsWith('/orders/estimate'),
    `주문 전에 견적이 먼저 나가야 한다. 실제 첫 요청: ${requests[0]?.method} ${requests[0]?.url}`,
  );
});

export { BookPrintNetworkError };
