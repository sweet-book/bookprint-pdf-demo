import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  runFlow,
} from '../../src/flow/index.js';
import { scriptedFetch, testClient } from '../helpers.js';

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

test('until 이 이미 DONE 인 단계를 가리키면 그 뒤 단계를 실행하지 않는다', async () => {
  const now = () => new Date('2026-09-08T03:00:00Z');
  const { fetchImpl } = scriptedFetch([]);
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
    { env: 'sandbox', now, uuid: () => 'u1' },
  );
  job.steps.createBook.status = 'DONE'; // 이전 실행에서 이미 끝난 작업
  const deps = { client: testClient(fetchImpl), store: new MemoryStore(), now };
  try {
    await runFlow(job, deps, { until: 'createBook' });
  } catch {
    // 여기로 오면 uploadCover 가 실행된 것이다
  }
  assert.equal(
    job.steps.uploadCover.status,
    'PENDING',
    'until=createBook 인데 uploadCover 가 실행됐다',
  );
});
