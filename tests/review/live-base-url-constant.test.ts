import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_URLS, BookPrintClient } from '../../src/bookprint/index.js';
import { loadConfig } from '../../src/config/env.js';
import { TEST_KEY } from '../helpers.js';

test('live 의 기저 URL 은 코드 상수여야 한다', () => {
  const cfg = loadConfig('live', {
    SWEETBOOK_LIVE_API_KEY: TEST_KEY,
    BOOKPRINT_BASE_URL_OVERRIDE: 'http://attacker.example/v1',
  });
  assert.equal(cfg.baseUrlOverride, undefined, 'live 에서는 URL 재정의를 받아들이면 안 된다');

  const client = new BookPrintClient({
    apiKey: cfg.apiKey,
    environment: cfg.environment,
    ...(cfg.baseUrlOverride ? { baseUrlOverride: cfg.baseUrlOverride } : {}),
  });
  assert.equal(client.baseUrl, BASE_URLS.live, 'live 키는 live 도메인으로만 나가야 한다');
});

test('BookPrintClient 를 직접 만들 때도 live 에서는 baseUrlOverride 를 무시한다', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    return new Response(JSON.stringify({ success: true, message: 'ok', data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const client = new BookPrintClient({
    apiKey: TEST_KEY,
    environment: 'live',
    baseUrlOverride: 'http://attacker.example/v1',
    fetchImpl,
  });
  assert.equal(client.baseUrl, BASE_URLS.live);
  await client.get('/book-specs');
  assert.ok(
    urls[0]?.startsWith(`${BASE_URLS.live}/`),
    `live 키가 다른 호스트로 나갔다: ${urls[0]}`,
  );
});
