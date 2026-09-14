import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BookPrintNetworkError } from '../../src/bookprint/index.js';
import {
  createBook,
  createOrder,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  StepFailed,
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

const now = () => new Date('2026-09-09T03:00:00Z');
let seq = 0;
const uuid = () => `k-${++seq}`;
const shipping = {
  recipientName: 'a',
  recipientPhone: '010-0000-0000',
  postalCode: '06134',
  address1: 'Seoul Gangnam-daero 1',
};

async function tempPdf(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bp-cancel-'));
  const p = join(dir, 'cover.pdf');
  await writeFile(p, '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n');
  return p;
}

/** 요청이 나가는 순간 취소되는 fetch */
function abortingFetch(controller: AbortController): typeof fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    controller.abort(new Error('취소'));
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }) as typeof fetch;
}

test('업로드를 취소하면 UNKNOWN 이다 — 서버가 받았을 수 있으니 재개가 확인부터 한다', async () => {
  const coverPath = await tempPdf();
  const controller = new AbortController();
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath },
    { env: 'sandbox', now, uuid },
  );
  job.bookUid = 'bk_test';
  job.steps.createBook.status = 'DONE';
  const deps = {
    client: testClient(abortingFetch(controller)),
    store: new MemoryStore(),
    now,
    signal: controller.signal,
  };
  await assert.rejects(uploadCover(job, deps), StepFailed);
  assert.equal(job.steps.uploadCover.status, 'UNKNOWN', 'FAILED 가 아니다');
});

test('주문을 취소해도 UNKNOWN — 멱등 키는 그대로 남아 재개가 같은 키로 잇는다', async () => {
  const controller = new AbortController();
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', quantity: 1, shipping },
    { env: 'sandbox', now, uuid },
  );
  job.bookUid = 'bk_test';
  const key = job.steps.createOrder.idempotencyKey;
  const deps = {
    client: testClient(abortingFetch(controller)),
    store: new MemoryStore(),
    now,
    uuid,
    signal: controller.signal,
  };
  await assert.rejects(createOrder(job, deps), StepFailed);
  assert.equal(job.steps.createOrder.status, 'UNKNOWN');
  assert.equal(job.steps.createOrder.idempotencyKey, key, '키가 바뀌면 주문이 둘이 된다');
});

test('취소된 요청은 재시도하지 않는다 — 한 번만 나간다', async () => {
  const controller = new AbortController();
  const { requests } = scriptedFetch([]);
  const fetchImpl = abortingFetch(controller);
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
    { env: 'sandbox', now, uuid },
  );
  const deps = {
    client: testClient(fetchImpl),
    store: new MemoryStore(),
    now,
    signal: controller.signal,
  };
  await assert.rejects(createBook(job, deps), StepFailed);
  assert.equal(job.log.length, 1, '기록도 한 줄');
  assert.equal(job.log[0]?.attempt, 1);
  assert.equal(requests.length, 0);
});

test('**재시도 대기 중에도 취소가 먹는다** — Retry-After 30초를 끝까지 기다리지 않는다', async () => {
  const controller = new AbortController();
  let slept = 0;
  // 실제로 기다리는 sleep — 취소가 먹지 않으면 30초를 기다린다
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      slept += ms;
      setTimeout(r, ms);
    });
  const { fetchImpl } = scriptedFetch([networkFailure, networkFailure]);
  const client = testClient(fetchImpl, { sleep });
  const started = Date.now();
  setTimeout(() => controller.abort(new Error('취소')), 20);
  await assert.rejects(
    client.request({
      method: 'POST',
      path: '/books',
      json: {},
      idempotencyKey: 'k',
      signal: controller.signal,
      retry: true,
    }),
    BookPrintNetworkError,
  );
  const elapsed = Date.now() - started;
  assert.ok(slept >= 800, `백오프 대기에 들어갔어야 한다 (요청한 대기 ${slept}ms)`);
  assert.ok(elapsed < 700, `대기를 끝까지 기다리면 안 된다 — ${elapsed}ms 걸렸다`);
});

test('취소 신호가 없으면 평소대로 재시도한다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    networkFailure,
    { status: 201, body: fixture('book_create_201.json').raw },
  ]);
  const res = await testClient(fetchImpl).request({
    method: 'POST',
    path: '/books',
    json: {},
    idempotencyKey: 'k',
  });
  assert.equal(res.attempts, 2);
  assert.equal(requests.length, 2);
});
