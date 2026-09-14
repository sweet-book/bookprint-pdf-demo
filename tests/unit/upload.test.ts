import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { probePdf } from '../../src/bookprint/index.js';
import {
  FlowRuleError,
  type JobState,
  type JobStore,
  type JobSummary,
  newJob,
  replacePdf,
  runFlow,
  StepFailed,
  uploadCover,
} from '../../src/flow/index.js';
import { fixture, networkFailure, scriptedFetch, testClient } from '../helpers.js';

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

let dir: string;
let coverPath: string;
let contentsPath: string;
let seq = 0;
const uuid = () => `uuid-${++seq}`;
const now = () => new Date('2026-09-08T03:00:00Z');

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bp-up-'));
  coverPath = join(dir, 'cover.pdf');
  contentsPath = join(dir, 'inner.pdf');
  await writeFile(coverPath, '%PDF-1.4 cover');
  await writeFile(contentsPath, '%PDF-1.4 inner');
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function jobWithBook(): JobState {
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath, contentsPath },
    { env: 'sandbox', now, uuid },
  );
  job.bookUid = 'bk_test';
  job.steps.createBook.status = 'DONE';
  return job;
}

test('책 생성 → 표지 → 내지가 한 흐름으로 돈다. 업로드 요청은 multipart 스트림 + Content-Length', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('book_create_201.json').raw },
    { status: 201, body: fixture('cover_put_200.json').raw },
    { status: 201, body: fixture('contents_post_201.json').raw },
  ]);
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't', coverPath, contentsPath },
    { env: 'sandbox', now, uuid },
  );
  const done = await runFlow(
    job,
    { client: testClient(fetchImpl), store: new MemoryStore(), now },
    { until: 'uploadContents' },
  );
  assert.equal(done.steps.uploadCover.status, 'DONE');
  assert.equal(done.steps.uploadContents.status, 'DONE');
  assert.equal(done.steps.finalize.status, 'PENDING');
  const up = requests[1];
  assert.ok(up);
  assert.equal(up.method, 'POST');
  assert.match(up.url, /\/books\/bk_7H7BF7a6g3rU\/pdf-cover$/);
  assert.match(up.headers['Content-Type'] ?? '', /^multipart\/form-data; boundary=/);
  assert.equal(
    up.headers['Content-Length'],
    String(
      Buffer.byteLength('%PDF-1.4 cover') + 0 + lengthOfWrapper(up.headers['Content-Type'] ?? ''),
    ),
  );
  assert.equal(up.headers['Idempotency-Key'], undefined, '업로드에는 멱등 키가 없다');
  assert.equal(up.body, '<non-string body>', '스트림 본문');
  assert.deepEqual(done.steps.uploadCover.detail?.pdfSizeMm, { width: 544, height: 288 });
  assert.equal(done.log.length, 3);
});

test('규격 불일치 400 — FAILED, errors 전부 보존, 재시도 없음', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 400, body: fixture('cover_put_badsize_400.json').raw },
  ]);
  const job = jobWithBook();
  await assert.rejects(
    uploadCover(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    StepFailed,
  );
  assert.equal(job.steps.uploadCover.status, 'FAILED');
  assert.equal(job.steps.uploadCover.error?.errorCode, 'ERR_VALIDATION_FAILED');
  assert.equal(job.steps.uploadCover.error?.errors.length, 3);
  assert.equal(requests.length, 1);
});

test('응답 유실 — UNKNOWN, 자동 재POST 없음', async () => {
  const { fetchImpl, requests } = scriptedFetch([networkFailure]);
  const job = jobWithBook();
  await assert.rejects(
    uploadCover(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    StepFailed,
  );
  assert.equal(job.steps.uploadCover.status, 'UNKNOWN');
  assert.equal(requests.length, 1);
});

test('409 이미 등록 — DONE 으로 본다 (응답 유실 뒤 재실행의 정상 경로)', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 409, body: fixture('cover_post_again_409.json').raw },
  ]);
  const job = jobWithBook();
  const done = await uploadCover(job, {
    client: testClient(fetchImpl),
    store: new MemoryStore(),
    now,
  });
  assert.equal(done.steps.uploadCover.status, 'DONE');
  assert.equal(done.steps.uploadCover.detail?.alreadyUploaded, true);
});

test('사전 검사 실패는 서버에 닿지 않는다', async () => {
  const { fetchImpl, requests } = scriptedFetch([]);
  const job = jobWithBook();
  job.input.coverPath = join(dir, 'missing.pdf');
  await assert.rejects(
    uploadCover(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    StepFailed,
  );
  assert.equal(job.steps.uploadCover.status, 'FAILED');
  assert.match(job.steps.uploadCover.error?.message ?? '', /찾을 수 없/);
  assert.equal(requests.length, 0);
});

test('경로 누락은 FAILED + FlowRuleError', async () => {
  const { fetchImpl, requests } = scriptedFetch([]);
  const job = jobWithBook();
  delete job.input.coverPath;
  await assert.rejects(
    uploadCover(job, { client: testClient(fetchImpl), store: new MemoryStore(), now }),
    (e: unknown) => e instanceof StepFailed && e.cause instanceof FlowRuleError,
  );
  assert.equal(requests.length, 0);
});

test('교체는 PUT, 주문 뒤에는 앱이 잠근다 — 서버는 제작 확정 이후에만 막는다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('cover_put_200.json').raw },
  ]);
  const job = jobWithBook();
  job.steps.uploadCover.status = 'DONE';
  const done = await replacePdf(
    job,
    { client: testClient(fetchImpl), store: new MemoryStore(), now },
    'cover',
    coverPath,
  );
  assert.equal(requests[0]?.method, 'PUT');
  assert.equal(done.steps.uploadCover.detail?.replaced, true);

  job.steps.createOrder.status = 'DONE';
  await assert.rejects(
    replacePdf(
      job,
      { client: testClient(fetchImpl), store: new MemoryStore(), now },
      'cover',
      coverPath,
    ),
    FlowRuleError,
  );
  assert.equal(requests.length, 1, '잠긴 뒤에는 요청이 나가지 않는다');
});

test('probePdf — 200 이면 본문을 읽지 않고 present, 404 ERR_PDF_NOT_UPLOADED 면 absent', async () => {
  const big = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(1024));
    },
  });
  let cancelled = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/pdf-cover')) {
      const res = new Response(big, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '999999999' },
      });
      const orig = res.body;
      // cancel 을 감지하기 위해 body 를 감싼다
      Object.defineProperty(res, 'body', {
        value: {
          cancel: async () => {
            cancelled = true;
            await orig?.cancel();
          },
        },
      });
      return res;
    }
    return new Response(
      fixture('book_create_201.json')
        .raw.replace('책 생성 완료', 'x')
        .replace('"success":true', '"success":false')
        .replace(
          '"data":{',
          '"errorCode":"ERR_PDF_NOT_UPLOADED","errors":["PDF 파일이 업로드되지 않았습니다."],"fieldErrors":[],"data":{',
        ),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  const client = testClient(fetchImpl);
  assert.equal((await probePdf(client, 'bk', 'cover')).state, 'present');
  assert.equal(cancelled, true, '본문을 cancel 했다');
  assert.equal((await probePdf(client, 'bk', 'contents')).state, 'absent');
});

/** multipart 머리+꼬리 길이 */
function lengthOfWrapper(contentType: string): number {
  const boundary = contentType.replace('multipart/form-data; boundary=', '');
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return Buffer.byteLength(head) + Buffer.byteLength(tail);
}
