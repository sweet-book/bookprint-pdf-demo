import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBook,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  nextStep,
  runFlow,
  StepFailed,
} from '../../src/flow/index.js';
import { fixture, networkFailure, scriptedFetch, TEST_KEY, testClient } from '../helpers.js';

/** 메모리 저장소 */
class MemoryStore implements JobStore {
  saves = 0;
  private map = new Map<string, string>();
  async get(id: string): Promise<JobState | null> {
    const s = this.map.get(id);
    return s ? (JSON.parse(s) as JobState) : null;
  }
  async save(job: JobState): Promise<void> {
    this.saves += 1;
    this.map.set(job.id, JSON.stringify(job));
  }
  async list(): Promise<JobSummary[]> {
    return [];
  }
}

let seq = 0;
const uuid = () => `uuid-${++seq}`;
const now = () => new Date('2026-09-08T03:00:00Z');
const input = { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 'test' };

test('newJob — 책 생성·최종화·주문에만 멱등 키를 미리 만든다', () => {
  const job = newJob(input, { env: 'sandbox', now, uuid });
  assert.ok(job.steps.createBook.idempotencyKey);
  assert.ok(job.steps.finalize.idempotencyKey);
  assert.ok(job.steps.createOrder.idempotencyKey);
  assert.equal(job.steps.uploadCover.idempotencyKey, null);
  assert.equal(job.steps.uploadContents.idempotencyKey, null);
  assert.equal(nextStep(job), 'createBook');
  assert.match(job.id, /^j_\d{8}-\d{4}-/);
});

test('createBook 성공 — bookUid 저장, DONE, 기록에 원본, 키는 없다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('book_create_201.json').raw },
  ]);
  const store = new MemoryStore();
  const job = newJob(input, { env: 'sandbox', now, uuid });
  const done = await createBook(job, { client: testClient(fetchImpl), store, now });
  assert.equal(done.bookUid, 'bk_7H7BF7a6g3rU');
  assert.equal(done.steps.createBook.status, 'DONE');
  assert.equal(requests[0]?.headers['Idempotency-Key'], job.steps.createBook.idempotencyKey);
  assert.ok(requests[0]?.body?.includes(`"externalRef":"${job.id}"`), 'externalRef 는 작업 id');
  assert.equal(
    store.saves,
    2,
    'RUNNING 을 호출 전에 저장해야 응답을 못 받아도 보낸 사실이 남는다 (RUNNING 저장 → DONE 저장)',
  );
  assert.equal(done.log.length, 1);
  assert.equal(done.log[0]?.response?.status, 201);
  assert.ok(!JSON.stringify(done).includes(TEST_KEY), '작업 파일에 키가 없다');
});

test('createBook 서버 거부(400) — FAILED, fieldErrors 보존, StepFailed', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 400, body: fixture('book_create_increment_400.json').raw },
  ]);
  const store = new MemoryStore();
  const job = newJob({ ...input, pageCount: 25 }, { env: 'sandbox', now, uuid });
  await assert.rejects(createBook(job, { client: testClient(fetchImpl), store, now }), StepFailed);
  assert.equal(job.steps.createBook.status, 'FAILED');
  assert.equal(job.steps.createBook.error?.errorCode, 'ERR_PAGECOUNT_INVALID');
  assert.equal(job.steps.createBook.error?.fieldErrors[0]?.constraint, 'increment');
  assert.equal(job.log[0]?.error?.errorCode, 'ERR_PAGECOUNT_INVALID');
});

test('createBook 응답 유실 — UNKNOWN (서버에 반영됐을 수 있다 → recover 대상)', async () => {
  const { fetchImpl } = scriptedFetch([
    networkFailure,
    networkFailure,
    networkFailure,
    networkFailure,
  ]);
  const store = new MemoryStore();
  const job = newJob(input, { env: 'sandbox', now, uuid });
  await assert.rejects(createBook(job, { client: testClient(fetchImpl), store, now }), StepFailed);
  assert.equal(job.steps.createBook.status, 'UNKNOWN');
  assert.equal(job.steps.createBook.error?.status, null);
});

test('같은 작업을 다시 돌리면 같은 멱등 키로 보낸다 — 재시도 안전', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    networkFailure,
    networkFailure,
    networkFailure,
    networkFailure,
    {
      status: 201,
      body: fixture('book_create_201.json').raw,
      headers: { 'x-idempotent-replayed': 'true' },
    },
  ]);
  const store = new MemoryStore();
  const job = newJob(input, { env: 'sandbox', now, uuid });
  const client = testClient(fetchImpl);
  await assert.rejects(createBook(job, { client, store, now }), StepFailed);
  const done = await runFlow(job, { client, store, now }, { until: 'createBook' });
  assert.equal(done.steps.createBook.status, 'DONE');
  assert.equal(done.steps.createBook.replayed, true);
  const keys = new Set(requests.map((r) => r.headers['Idempotency-Key']));
  assert.equal(keys.size, 1, '모든 시도가 같은 키');
});

test('runFlow — until 로 지정한 단계 뒤에 멈춘다', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 201, body: fixture('book_create_201.json').raw }]);
  const job = newJob(input, { env: 'sandbox', now, uuid });
  const done = await runFlow(
    job,
    { client: testClient(fetchImpl), store: new MemoryStore(), now },
    { until: 'createBook' },
  );
  assert.equal(nextStep(done), 'uploadCover');
  assert.equal(done.steps.uploadCover.status, 'PENDING');
});
