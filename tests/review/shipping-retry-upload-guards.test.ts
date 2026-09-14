import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  parseShipping,
  uploadCover,
} from '../../src/flow/index.js';
import { scriptedFetch, testClient } from '../helpers.js';

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

test('파트너가 일부러 넣은 항목을 오타로 몰아 막지 않는다', () => {
  const base = {
    recipientName: '홍길동',
    recipientPhone: '010-1234-5678',
    postalCode: '06134',
    address1: '서울 강남구 테헤란로 100',
  };
  // 편집 거리 3 이상인 모르는 키
  assert.doesNotThrow(() => parseShipping({ ...base, country: 'KR' }));
  // 편집 거리 2 이하인 모르는 키
  assert.doesNotThrow(() => parseShipping({ ...base, addressee: '주식회사 파트너' }));
  assert.doesNotThrow(() => parseShipping({ ...base, address3: '3층' }));
});

test('재시도 대기가 abort 리스너를 남기지 않는다', async () => {
  const err429 = {
    status: 429,
    body: JSON.stringify({
      success: false,
      message: 'slow down',
      data: null,
      errorCode: 'ERR_TOO_MANY_REQUESTS',
      errors: [],
      fieldErrors: [],
    }),
    headers: { 'retry-after': '1' },
  };
  const { fetchImpl } = scriptedFetch([
    err429,
    err429,
    { status: 200, body: JSON.stringify({ success: true, message: 'ok', data: { ok: true } }) },
  ]);
  const client = testClient(fetchImpl); // sleep 은 즉시 resolve
  const ac = new AbortController();
  await client.request({ method: 'GET', path: '/book-specs', signal: ac.signal });
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, '대기마다 리스너가 쌓인다');
});

test('로컬 파일 검사 실패가 UNKNOWN 을 FAILED 로 덮지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-keep-'));
  const cover = join(dir, 'cover.pdf');
  // PDF 시그니처(%PDF-)가 없는 파일
  await writeFile(cover, 'this is not a pdf', 'latin1');
  let n = 0;
  const job = newJob(
    {
      bookSpecUid: 'SQUAREBOOK_HC',
      pageCount: 24,
      title: 't',
      coverPath: cover,
      contentsPath: cover,
    },
    { env: 'sandbox', now: () => new Date('2026-09-09T00:00:00Z'), uuid: () => `u-${++n}` },
  );
  job.bookUid = 'bk_1';
  job.steps.createBook.status = 'DONE';
  job.steps.uploadCover.status = 'UNKNOWN'; // 지난번 업로드 응답을 못 받았다
  // 서버는 부르지 않는다
  const { fetchImpl } = scriptedFetch([]);
  const deps = {
    client: testClient(fetchImpl),
    store: new MemoryStore(),
    now: () => new Date('2026-09-09T00:01:00Z'),
  };
  await assert.rejects(uploadCover(job, deps));
  await rm(dir, { recursive: true, force: true });
  assert.equal(
    job.steps.uploadCover.status,
    'UNKNOWN',
    'FAILED 로 덮이면 다음 resume 이 probe 를 건너뛴다',
  );
});
