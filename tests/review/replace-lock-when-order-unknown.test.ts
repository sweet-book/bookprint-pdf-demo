import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FlowRuleError,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  replacePdf,
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

test('주문이 UNKNOWN 인 책의 PDF 교체는 거부돼야 한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-lock-'));
  const p = join(dir, 'new.pdf');
  await writeFile(p, '%PDF-1.4 new');
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('cover_put_200.json').raw },
  ]);
  let seq = 0;
  const now = () => new Date('2026-09-08T03:00:00Z');
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath: p },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  for (const s of ['createBook', 'uploadCover', 'uploadContents', 'finalize', 'estimate'] as const)
    job.steps[s].status = 'DONE';
  job.steps.createOrder.status = 'UNKNOWN'; // 주문이 서버에 들어갔을 수 있다
  await assert.rejects(
    () =>
      replacePdf(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }, 'cover', p),
    FlowRuleError,
  );
  assert.equal(requests.length, 0, '서버에 PUT 이 나가면 안 된다');
});
