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
  supplyNewPdf,
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

const now = () => new Date('2026-09-09T03:00:00Z');

async function onePagePdf(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bp-supply-'));
  const p = join(dir, name);
  await writeFile(
    p,
    '%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >>\n<< /Type /Page >>\n%%EOF',
    'latin1',
  );
  return p;
}

test('UNKNOWN 단계에서 파일을 고쳐 오면 옛 파일을 확인하고 **교체**한다', async () => {
  const fixed = await onePagePdf('fixed-cover.pdf');
  const { fetchImpl, requests } = scriptedFetch([
    // ① probe — 옛(잘못된) 표지가 이미 서버에 있다
    { status: 200, body: '{"success":true,"message":"ok","data":null}' },
    // ② 고친 표지를 PUT 으로 교체
    { status: 200, body: fixture('cover_put_200.json').raw },
  ]);
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath: 'old-cover.pdf' },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  job.steps.createBook.status = 'DONE';
  job.steps.uploadCover.status = 'UNKNOWN';

  const result = await supplyNewPdf(
    job,
    { client: testClient(fetchImpl), store: new MemoryStore(), now },
    'cover',
    fixed,
  );

  assert.equal(result, 'replaced');
  assert.equal(requests.length, 2, 'probe 로 확인하고 고친 파일을 보낸다');
  assert.equal(requests[1]?.method, 'PUT', '이미 있으니 교체다');
  assert.equal(job.input.coverPath, fixed);
  assert.equal(job.steps.uploadCover.status, 'DONE');
});

test('서버에 없으면 경로만 바꾸고 PENDING 으로 되돌려 다음 단계가 올린다', async () => {
  const fixed = await onePagePdf('fixed-inner.pdf');
  const { fetchImpl, requests } = scriptedFetch([
    { status: 404, body: fixture('pdf_absent_404.json').raw },
  ]);
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath: 'old.pdf' },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  job.steps.createBook.status = 'DONE';
  job.steps.uploadCover.status = 'UNKNOWN';

  const result = await supplyNewPdf(
    job,
    { client: testClient(fetchImpl), store: new MemoryStore(), now },
    'cover',
    fixed,
  );

  assert.equal(result, 'queued');
  assert.equal(requests.length, 1, 'probe 만 나간다');
  assert.equal(job.input.coverPath, fixed);
  assert.equal(job.steps.uploadCover.status, 'PENDING', '다음 실행이 POST 한다');
});
