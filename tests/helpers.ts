import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BookPrintClient, type ClientOptions } from '../src/bookprint/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');

/** tests/fixtures/ 의 응답 원본을 읽는다. .html 은 text/html, 나머지는 application/json */
export function fixture(name: string): { raw: string; contentType: string } {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  const contentType = name.endsWith('.html')
    ? 'text/html; charset=us-ascii'
    : 'application/json; charset=utf-8';
  return { raw, contentType };
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ScriptedResponse {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/** fetch 대역 — 응답 대본을 순서대로 돌려주고 요청을 기록한다. 대본이 함수면 던진다(네트워크 오류 흉내). */
export function scriptedFetch(script: Array<ScriptedResponse | (() => never)>): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : init?.body ? '<non-string body>' : null,
    });
    const next = script[i++];
    if (next === undefined)
      throw new Error(`scriptedFetch: no response scripted for request #${i}`);
    if (typeof next === 'function') return next();
    return new Response(next.body, {
      status: next.status,
      headers: {
        'content-type': next.contentType ?? 'application/json; charset=utf-8',
        ...(next.headers ?? {}),
      },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

export const TEST_KEY = 'SBTESTKEY000.abcdefghijklmnopqrstuvwxyz012345';

export function testClient(
  fetchImpl: typeof fetch,
  extra: Partial<ClientOptions> = {},
): BookPrintClient {
  return new BookPrintClient({
    apiKey: TEST_KEY,
    environment: 'sandbox',
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });
}

export function networkFailure(): never {
  throw new TypeError('fetch failed');
}

export function timeoutFailure(): never {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  throw e;
}
