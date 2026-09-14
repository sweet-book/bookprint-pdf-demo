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

test('응답 유실(UNKNOWN) 업로드를 재개하면 다시 올리기 전에 올라갔는지 확인한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-reprobe-'));
  const coverPath = join(dir, 'cover.pdf');
  await writeFile(coverPath, '%PDF-1.4 cover');

  // 서버에는 이미 표지가 있다
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('cover_put_200.json').raw },
    { status: 409, body: fixture('cover_post_again_409.json').raw },
  ]);
  let seq = 0;
  const now = () => new Date('2026-09-08T03:00:00Z');
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath },
    { env: 'sandbox', now, uuid: () => `uuid-${++seq}` },
  );
  job.bookUid = 'bk_test';
  job.steps.createBook.status = 'DONE';
  job.steps.uploadCover.status = 'UNKNOWN'; // 직전 실행에서 응답을 받지 못했다

  try {
    await runFlow(
      job,
      { client: testClient(fetchImpl), store: new MemoryStore(), now },
      { until: 'uploadCover' },
    );
  } catch {
    // 첫 요청만 본다
  }

  const first = requests[0];
  assert.ok(first, '재개가 요청을 하나는 보냈다');
  assert.equal(
    first.method,
    'GET',
    `업로드 재개는 GET 상태 확인이 먼저여야 한다. 실제: ${first.method} ${first.url}`,
  );
});
