import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimate,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  StepFailed,
} from '../../src/flow/index.js';
import { scriptedFetch, TEST_KEY, testClient } from '../helpers.js';

class MemoryStore implements JobStore {
  saved: string[] = [];
  private m = new Map<string, string>();
  async get(id: string): Promise<JobState | null> {
    const s = this.m.get(id);
    return s ? (JSON.parse(s) as JobState) : null;
  }
  async save(job: JobState): Promise<void> {
    const t = JSON.stringify(job);
    this.m.set(job.id, t);
    this.saved.push(t);
  }
  async list(): Promise<JobSummary[]> {
    return [];
  }
}

const now = () => new Date('2026-09-09T03:00:00Z');

test('잔액 부족으로 멈춘 견적의 detail 도 키를 가린다', async () => {
  const body = JSON.stringify({
    success: true,
    message: '성공',
    data: {
      items: [],
      productAmount: 1,
      shippingFee: 0,
      packagingFee: 0,
      totalAmount: 1,
      paidCreditAmount: 2,
      creditBalance: 0,
      creditSufficient: false,
      // 게이트웨이가 요청 헤더를 되비춘 경우
      currency: `KRW (echo Authorization: Bearer ${TEST_KEY})`,
    },
  });
  const { fetchImpl } = scriptedFetch([{ status: 200, body }]);
  let seq = 0;
  const store = new MemoryStore();
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', quantity: 1 },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  await assert.rejects(estimate(job, { client: testClient(fetchImpl), store, now }), StepFailed);
  const persisted = store.saved[store.saved.length - 1] as string;
  assert.ok(!persisted.includes(TEST_KEY), '작업 파일 어디에도 키 평문이 있으면 안 된다');
});
