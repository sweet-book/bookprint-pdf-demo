import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  runFlow,
  uploadCover,
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

const now = () => new Date('2026-09-08T03:00:00Z');

async function tempPdf(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const p = join(dir, 'cover.pdf');
  await writeFile(p, '%PDF-1.4 cover');
  return p;
}

test('RUNNING 에서 재개해도 올라갔는지 먼저 확인한다', async () => {
  const coverPath = await tempPdf('bp-run-');
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('cover_put_200.json').raw },
    { status: 409, body: fixture('cover_post_again_409.json').raw },
  ]);
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_test';
  job.steps.createBook.status = 'DONE';
  job.steps.uploadCover.status = 'RUNNING'; // kill -9 이 남긴 상태
  try {
    await runFlow(
      job,
      { client: testClient(fetchImpl), store: new MemoryStore(), now },
      { until: 'uploadCover' },
    );
  } catch {
    // 첫 요청만 본다
  }
  assert.equal(
    requests[0]?.method,
    'GET',
    `RUNNING 재개도 확인이 먼저여야 한다. 실제: ${requests[0]?.method}`,
  );
});

test('확인(probe)이 실패해도 UNKNOWN 을 FAILED 로 바꾸지 않는다', async () => {
  const coverPath = await tempPdf('bp-probe-');
  const { fetchImpl } = scriptedFetch([
    {
      status: 500,
      body: JSON.stringify({
        success: false,
        message: 'boom',
        data: null,
        errorCode: 'ERR_INTERNAL_ERROR',
        errors: [],
        fieldErrors: [],
      }),
    },
    { status: 409, body: fixture('cover_post_again_409.json').raw },
  ]);
  let seq = 0;
  const deps = { client: testClient(fetchImpl), store: new MemoryStore(), now };
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  job.steps.createBook.status = 'DONE';
  job.steps.uploadCover.status = 'UNKNOWN';
  await assert.rejects(uploadCover(job, deps));
  assert.equal(
    job.steps.uploadCover.status,
    'UNKNOWN',
    'probe 가 실패했다고 응답 유실 사실이 사라지면 안 된다',
  );
});
