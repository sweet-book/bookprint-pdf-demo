import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCredits, sandboxChargeCredits } from '../../src/bookprint/index.js';
import { scriptedFetch, testClient } from '../helpers.js';

/** GET /credits 200 응답 */
const ACCOUNT_200 = JSON.stringify({
  success: true,
  message: '성공',
  data: {
    accountUid: 'acc_test',
    balance: 99000.0,
    currency: 'KRW',
    createdAt: '2026-09-04T07:27:07.000Z',
    updatedAt: '2026-09-09T05:39:38.000Z',
    env: 'test',
  },
});

test('getCredits 는 GET /credits 를 부르고 잔액을 준다', async () => {
  const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: ACCOUNT_200 }]);
  const res = await getCredits(testClient(fetchImpl));

  assert.equal(requests[0]?.method, 'GET');
  assert.ok(requests[0]?.url.endsWith('/credits'), requests[0]?.url);
  assert.equal(res.data.balance, 99000);
  assert.equal(res.data.env, 'test');
});

test('sandboxChargeCredits 는 amount 와 memo 를 본문에 싣는다', async () => {
  const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: ACCOUNT_200 }]);
  await sandboxChargeCredits(testClient(fetchImpl), { amount: 50000, memo: '테스트 충전' });

  const req = requests[0];
  assert.equal(req?.method, 'POST');
  assert.ok(req?.url.endsWith('/credits/sandbox/charge'), req?.url);
  assert.deepEqual(JSON.parse(req?.body ?? '{}'), { amount: 50000, memo: '테스트 충전' });
});

test('한글 memo 를 위해 Content-Type 에 charset=utf-8 이 붙는다', async () => {
  const { fetchImpl, requests } = scriptedFetch([{ status: 200, body: ACCOUNT_200 }]);
  await sandboxChargeCredits(testClient(fetchImpl), { amount: 1000, memo: '한글' });

  assert.equal(requests[0]?.headers['Content-Type'], 'application/json; charset=utf-8');
});

test('충전은 멱등 키가 없으므로 재시도하지 않는다 — 두 번 충전될 수 있다', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    { status: 503, body: JSON.stringify({ success: false, message: '일시 오류' }) },
    { status: 200, body: ACCOUNT_200 },
  ]);
  await assert.rejects(() => sandboxChargeCredits(testClient(fetchImpl), { amount: 1000 }));
  assert.equal(requests.length, 1, '503 을 받고 다시 보내면 안 된다');
});
