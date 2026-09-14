import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BookPrintApiError,
  BookPrintNetworkError,
  BookPrintTimeoutError,
} from '../../src/bookprint/index.js';
import {
  fixture,
  networkFailure,
  scriptedFetch,
  TEST_KEY,
  testClient,
  timeoutFailure,
} from '../helpers.js';

const created = fixture('book_create_201.json').raw;

test('빈 POST 에는 Content-Length: 0 을 붙인다 — 없으면 IIS 411', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 201, body: fixture('finalize_201.json').raw },
  ]);
  await testClient(fetchImpl).request({
    method: 'POST',
    path: '/books/bk_x/finalization',
    idempotencyKey: 'k',
  });
  assert.equal(requests[0]?.headers['Content-Length'], '0');
  assert.equal(requests[0]?.body, null);
});

test('Authorization 은 전송되지만 요약(request)에는 없다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 200, body: fixture('bookspecs_list.json').raw },
  ]);
  const res = await testClient(fetchImpl).get('/book-specs');
  assert.equal(requests[0]?.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.ok(!('Authorization' in res.request.headers));
  assert.ok(!JSON.stringify(res.request).includes(TEST_KEY));
});

test('멱등 키를 그대로 보내고, 재현 헤더와 에코된 키를 읽는다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    {
      status: 201,
      body: created,
      headers: { 'x-idempotent-replayed': 'true', 'x-idempotent-key': 'my-key' },
    },
  ]);
  const res = await testClient(fetchImpl).request<{ bookUid: string }>({
    method: 'POST',
    path: '/books',
    json: { a: 1 },
    idempotencyKey: 'my-key',
  });
  assert.equal(requests[0]?.headers['Idempotency-Key'], 'my-key');
  assert.equal(res.replayed, true);
  assert.equal(res.requestId, 'my-key');
  assert.equal(res.data.bookUid, 'bk_7H7BF7a6g3rU');
});

test('429 → Retry-After 만큼 기다렸다가 같은 키로 재전송, 그 뒤 성공', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    {
      status: 429,
      body: '{"success":false,"message":"Too Many Requests","data":null,"errorCode":"ERR_TOO_MANY_REQUESTS","errors":[],"fieldErrors":[]}',
      headers: { 'retry-after': '2' },
    },
    { status: 201, body: created },
  ]);
  const waits: number[] = [];
  const client = testClient(fetchImpl, {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const res = await client.request({
    method: 'POST',
    path: '/books',
    json: {},
    idempotencyKey: 'k1',
  });
  assert.equal(res.attempts, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(requests[1]?.headers['Idempotency-Key'], 'k1');
});

test('400 은 재시도 없이 BookPrintApiError — envelope 6필드 보존', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 400, body: fixture('book_create_increment_400.json').raw },
  ]);
  await assert.rejects(
    testClient(fetchImpl).request({
      method: 'POST',
      path: '/books',
      json: {},
      idempotencyKey: 'k',
    }),
    (err: unknown) => {
      assert.ok(err instanceof BookPrintApiError);
      assert.equal(err.status, 400);
      assert.equal(err.errorCode, 'ERR_PAGECOUNT_INVALID');
      assert.equal(err.fieldError('pageCount')?.constraint, 'increment');
      assert.ok(err.errors.length > 0);
      assert.ok(err.raw.length > 0);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test('비JSON 오류(411 HTML)도 원문이 보존되고 errorCode 는 null', async () => {
  const html = fixture('finalize_nolen_411.html');
  const { fetchImpl } = scriptedFetch([
    { status: 411, body: html.raw, contentType: html.contentType },
  ]);
  await assert.rejects(testClient(fetchImpl).get('/x'), (err: unknown) => {
    assert.ok(err instanceof BookPrintApiError);
    assert.equal(err.status, 411);
    assert.equal(err.errorCode, null);
    assert.match(err.raw, /Length Required/);
    return true;
  });
});

test('멱등 키 없는 POST 는 네트워크 오류에도 재시도하지 않는다 (중복 위험)', async () => {
  const { fetchImpl, requests } = scriptedFetch([networkFailure, { status: 201, body: created }]);
  await assert.rejects(
    testClient(fetchImpl).request({ method: 'POST', path: '/orders', json: {} }),
    BookPrintNetworkError,
  );
  assert.equal(requests.length, 1);
});

test('retry:false 는 업로드처럼 재시도를 완전히 끈다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    {
      status: 500,
      body: '{"success":false,"message":"x","data":null,"errorCode":"ERR_INTERNAL_ERROR","errors":[],"fieldErrors":[]}',
    },
  ]);
  await assert.rejects(
    testClient(fetchImpl).request({
      method: 'POST',
      path: '/books/b/pdf-cover',
      retry: false,
      idempotencyKey: 'k',
    }),
    BookPrintApiError,
  );
  assert.equal(requests.length, 1);
});

test('GET 은 네트워크 오류 뒤 재시도한다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    networkFailure,
    { status: 200, body: fixture('bookspecs_list.json').raw },
  ]);
  const res = await testClient(fetchImpl).get('/book-specs');
  assert.equal(res.attempts, 2);
  assert.equal(requests.length, 2);
});

test('타임아웃은 BookPrintTimeoutError', async () => {
  const { fetchImpl } = scriptedFetch([
    timeoutFailure,
    timeoutFailure,
    timeoutFailure,
    timeoutFailure,
  ]);
  await assert.rejects(testClient(fetchImpl).get('/book-specs'), BookPrintTimeoutError);
});

test('retry:true 는 키 없는 POST 도 재시도한다 — 호출자가 부작용 없음을 보증 (견적)', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    networkFailure,
    { status: 200, body: fixture('estimate_200.json').raw },
  ]);
  const res = await testClient(fetchImpl).request({
    method: 'POST',
    path: '/orders/estimate',
    json: { items: [] },
    retry: true,
  });
  assert.equal(res.attempts, 2);
  assert.equal(requests.length, 2);
});
