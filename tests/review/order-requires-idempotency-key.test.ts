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
  async get(): Promise<JobState | null> {
    return null;
  }
  async save(): Promise<void> {}
  async list(): Promise<JobSummary[]> {
    return [];
  }
}

test('멱등 키가 없는 작업이면 주문을 보내지 말아야 한다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('order_create_201.json').raw },
  ]);
  let seq = 0;
  const now = () => new Date('2026-09-08T03:00:00Z');
  const job = newJob(
    {
      bookSpecUid: 'SQUAREBOOK_HC',
      pageCount: 24,
      title: 't',
      shipping: { recipientName: 'a', recipientPhone: 'b', postalCode: 'c', address1: 'd' },
    },
    { env: 'sandbox', now, uuid: () => `k-${++seq}` },
  );
  job.bookUid = 'bk_1';
  job.steps.createOrder.idempotencyKey = null; // 손으로 만들었거나 키가 빠진 작업 파일
  await createOrder(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }).catch(
    () => undefined,
  );
  assert.ok(
    requests.length === 0 || requests[0]?.headers['Idempotency-Key'],
    '키 없이 POST /orders 가 나갔다',
  );
});
