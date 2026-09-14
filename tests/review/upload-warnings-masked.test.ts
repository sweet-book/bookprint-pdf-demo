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
  uploadCover,
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

test('업로드 응답의 warnings 가 detail 로 들어가도 작업 파일에 키가 남지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-mask-'));
  const coverPath = join(dir, 'cover.pdf');
  await writeFile(coverPath, '%PDF-1.4 x');
  const body = JSON.stringify({
    success: true,
    message: 'ok',
    data: {
      bookUid: 'bk_1',
      kind: 'cover',
      valid: true,
      pdfSizeMm: { width: 544, height: 288 },
      messages: [],
      // 게이트웨이가 요청 헤더를 되비춘 경우
      warnings: [`요청 헤더 확인: Authorization: Bearer ${TEST_KEY}`],
      bookStatus: 1,
      url: null,
      pageMeta: {
        currentPageCount: 24,
        pageMin: 24,
        pageMax: 130,
        pageIncrement: 2,
        isValid: true,
      },
    },
  });
  const { fetchImpl } = scriptedFetch([{ status: 201, body }]);
  let seq = 0;
  const now = () => new Date('2026-09-08T03:00:00Z');
  const store = new MemoryStore();
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  job.bookUid = 'bk_1';
  job.steps.createBook.status = 'DONE';
  await uploadCover(job, { client: testClient(fetchImpl), store, now });
  const persisted = store.saved[store.saved.length - 1] as string;
  assert.ok(!persisted.includes(TEST_KEY), '작업 파일 어디에도 키 평문이 있으면 안 된다');
});
