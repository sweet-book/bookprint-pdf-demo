import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOrder,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
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

test('409 멱등 락으로 끝난 주문을 재개해도 같은 키로 다시 보낸다', async () => {
  // errorCode 없는 409(멱등 락) — 재시도 4회를 다 쓴다
  const lock = JSON.stringify({ success: false, message: '요청을 처리 중입니다', data: null });
  const { fetchImpl, requests } = scriptedFetch([
    { status: 409, body: lock },
    { status: 409, body: lock },
    { status: 409, body: lock },
    { status: 409, body: lock },
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  let seq = 0;
  const now = () => new Date('2026-09-08T03:00:00Z');
  const uuid = () => `k-${++seq}`;
  const deps = { client: testClient(fetchImpl), store: new MemoryStore(), now, uuid };
  const job = newJob(
    {
      bookSpecUid: 'SQUAREBOOK_HC',
      pageCount: 24,
      title: 't',
      quantity: 1,
      shipping: { recipientName: 'a', recipientPhone: 'b', postalCode: 'c', address1: 'd' },
    },
    { env: 'sandbox', now, uuid },
  );
  job.bookUid = 'bk_test';
  await assert.rejects(createOrder(job, deps));
  assert.equal(job.steps.createOrder.status, 'UNKNOWN');
  await createOrder(job, deps); // 사용자가 resume
  const first = requests[0]?.headers['Idempotency-Key'];
  const last = requests[requests.length - 1]?.headers['Idempotency-Key'];
  assert.equal(
    last,
    first,
    '서버가 처리 중이던 그 키로 다시 물어야 한다 — 새 키는 주문을 하나 더 만든다',
  );
});
