import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBook,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
} from '../../src/flow/index.js';
import { scriptedFetch, TEST_KEY, testClient } from '../helpers.js';

class MemoryStore implements JobStore {
  private map = new Map<string, string>();
  async get(id: string): Promise<JobState | null> {
    const s = this.map.get(id);
    return s ? (JSON.parse(s) as JobState) : null;
  }
  async save(job: JobState): Promise<void> {
    this.map.set(job.id, JSON.stringify(job));
  }
  async list(): Promise<JobSummary[]> {
    return [];
  }
}

test('응답 본문이 키를 되비춰도 작업 파일에 키가 남지 않는다', async () => {
  // 게이트웨이가 요청 헤더를 되비춘 본문
  const body = JSON.stringify({
    success: true,
    message: `accepted (Authorization: Bearer ${TEST_KEY})`,
    data: {
      bookUid: 'bk_1',
      pageMeta: {
        currentPageCount: 24,
        pageMin: 24,
        pageMax: 400,
        pageIncrement: 2,
        isValid: true,
      },
    },
  });
  const { fetchImpl } = scriptedFetch([{ status: 201, body }]);
  let seq = 0;
  const now = () => new Date('2026-09-08T03:00:00Z');
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
    { env: 'sandbox', now, uuid: () => `uuid-${++seq}` },
  );
  const done = await createBook(job, {
    client: testClient(fetchImpl),
    store: new MemoryStore(),
    now,
  });
  assert.ok(
    !JSON.stringify(done).includes(TEST_KEY),
    '작업 파일 어디에도 키 평문이 있으면 안 된다 (마스킹은 마지막 방어선)',
  );
});
