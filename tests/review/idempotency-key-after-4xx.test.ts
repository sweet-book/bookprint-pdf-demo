import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBook,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  StepFailed,
} from '../../src/flow/index.js';
import { fixture, scriptedFetch, testClient } from '../helpers.js';

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

function fixtureDeps(script: Parameters<typeof scriptedFetch>[0]) {
  let seq = 0;
  const { fetchImpl, requests } = scriptedFetch(script);
  const now = () => new Date('2026-09-09T01:00:00Z');
  const uuid = () => `k-${++seq}`;
  return { deps: { client: testClient(fetchImpl), store: new MemoryStore(), now, uuid }, requests };
}

test('400 으로 실패한 단계를 고쳐 재실행하면 **같은 키**를 쓴다 — 검증 실패는 키에 묶이지 않는다', async () => {
  const { deps, requests } = fixtureDeps([
    { status: 400, body: fixture('book_create_increment_400.json').raw },
    { status: 201, body: fixture('book_create_201.json').raw },
  ]);
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 25, title: 't' },
    { env: 'sandbox', now: deps.now, uuid: deps.uuid },
  );
  await assert.rejects(createBook(job, deps), StepFailed);
  assert.equal(job.steps.createBook.status, 'FAILED');

  job.input.pageCount = 24; // 사용자가 입력을 고쳤다
  await createBook(job, deps);

  assert.equal(
    requests[1]?.headers['Idempotency-Key'],
    requests[0]?.headers['Idempotency-Key'],
    '검증 실패는 키를 묶지 않는다. 새 키를 만들면 응답 유실·409 락에서 요청이 둘이 된다',
  );
});

test('422 키 불일치일 때만 새 키 — 그 키는 이미 다른 본문에 묶여 있다', async () => {
  const { deps, requests } = fixtureDeps([
    { status: 422, body: fixture('book_create_mismatch_422.json').raw },
    { status: 201, body: fixture('book_create_201.json').raw },
  ]);
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
    { env: 'sandbox', now: deps.now, uuid: deps.uuid },
  );
  await assert.rejects(createBook(job, deps), StepFailed);
  assert.equal(job.steps.createBook.error?.errorCode, 'ERR_IDEMPOTENCY_KEY_MISMATCH');

  await createBook(job, deps);

  assert.notEqual(
    requests[1]?.headers['Idempotency-Key'],
    requests[0]?.headers['Idempotency-Key'],
    '같은 키로는 영영 성공할 수 없다',
  );
});
