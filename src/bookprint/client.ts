import { setTimeout as timersSetTimeout } from 'node:timers/promises';
import {
  BookPrintApiError,
  BookPrintNetworkError,
  BookPrintTimeoutError,
  type RequestSummary,
} from './errors.js';
import { DEFAULT_RETRY_POLICY, decideRetry, parseRetryAfter, type RetryPolicy } from './retry.js';
import type { Envelope, Environment, FieldError } from './types.js';

export const BASE_URLS: Readonly<Record<Environment, string>> = {
  sandbox: 'https://api-sandbox.sweetbook.com/v1',
  live: 'https://api.sweetbook.com/v1',
};

export interface ClientOptions {
  apiKey: string;
  environment: Environment;
  /** 테스트 전용. live 에서는 무시된다 */
  baseUrlOverride?: string;
  /** 시도당 타임아웃(ms). 기본 30000 */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** 테스트 주입 */
  fetchImpl?: typeof fetch;
  /** 재시도 대기. signal 이 취소되면 바로 끝나야 한다 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export type FetchBody = NonNullable<RequestInit['body']>;

/** JSON 이 아닌 요청 본문 (multipart 스트림) */
export interface RawBody {
  body: FetchBody;
  contentType: string;
  /** 바이트 수. 알면 넣는다 */
  contentLength?: number;
  /** 기록용 한 줄 (파일명·크기) */
  summary: string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** '/books' 처럼 base 뒤에 붙는 경로 */
  path: string;
  query?: Readonly<Record<string, string | number | undefined>>;
  json?: unknown;
  raw?: RawBody;
  /** Idempotency-Key 헤더. 재시도는 같은 키를 쓴다 */
  idempotencyKey?: string;
  /**
   * 재시도 여부. 생략 = GET 이거나 멱등 키가 있을 때만 / true = 키 없는 POST 도 / false = 끔.
   * 스트림 본문(raw)은 언제나 재시도하지 않는다.
   */
  retry?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApiResult<T> {
  data: T;
  envelope: Envelope<T>;
  status: number;
  headers: Readonly<Record<string, string>>;
  /** 서버가 멱등 캐시로 답했는가 (X-Idempotent-Replayed: true) */
  replayed: boolean;
  /** 요청 식별자 — 서버가 돌려준 멱등 키, 없으면 보낸 키 */
  requestId: string | null;
  attempts: number;
  durationMs: number;
  request: RequestSummary;
}

/** probe() 결과. 성공이면 본문이 없고, 오류면 envelope 필드를 담는다 */
export interface ProbeResult {
  status: number;
  headers: Readonly<Record<string, string>>;
  errorCode: string | null;
  message: string | null;
  errors: string[];
  fieldErrors: FieldError[];
  data: unknown;
  raw: string;
  request: RequestSummary;
}

export interface ParsedResponse<T> {
  envelope: Envelope<T> | null;
  raw: string;
  isJson: boolean;
}

/** 응답 본문을 envelope 로. JSON envelope 가 아니면 envelope 는 null 이고 raw 만 남는다 */
export function parseResponse<T>(contentType: string | undefined, raw: string): ParsedResponse<T> {
  const isJson = (contentType ?? '').toLowerCase().includes('json');
  if (!isJson || raw.length === 0) return { envelope: null, raw, isJson: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('success' in parsed)) {
      return { envelope: null, raw, isJson: true };
    }
    return { envelope: parsed as Envelope<T>, raw, isJson: true };
  } catch {
    return { envelope: null, raw, isJson: false };
  }
}

export class BookPrintClient {
  readonly environment: Environment;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: ClientOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    this.apiKey = options.apiKey;
    this.environment = options.environment;
    const override = options.environment === 'live' ? undefined : options.baseUrlOverride;
    this.baseUrl = (override ?? BASE_URLS[options.environment]).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async request<T>(opts: RequestOptions): Promise<ApiResult<T>> {
    if (opts.signal?.aborted) {
      const e = new Error('요청 전에 취소됐다 — 보내지 않았다');
      e.name = 'AbortError';
      throw e;
    }
    const url = this.buildUrl(opts.path, opts.query);
    const { headers, body, summary } = this.buildBody(opts);
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const request: RequestSummary = {
      method: opts.method,
      url,
      headers: { ...headers },
      bodySummary: summary,
    };
    const sendHeaders: Record<string, string> = {
      ...headers,
      Authorization: `Bearer ${this.apiKey}`,
    };

    const streaming = body instanceof ReadableStream;
    const canRetry =
      opts.retry !== false &&
      !streaming &&
      (opts.retry === true || opts.method === 'GET' || opts.idempotencyKey !== undefined);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const started = this.now();
    let attempt = 0;

    for (;;) {
      attempt += 1;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: opts.method,
          headers: sendHeaders,
          signal: combineSignals(opts.signal, AbortSignal.timeout(timeoutMs)),
          ...(body !== undefined ? { body } : {}),
          ...(streaming ? { duplex: 'half' as const } : {}),
        });
      } catch (cause) {
        const err = toNetworkError(cause, timeoutMs, request, attempt);
        if (opts.signal?.aborted) throw err;
        const d = canRetry
          ? decideRetry({
              attempt,
              status: null,
              errorCode: null,
              retryAfterSec: null,
              elapsedMs: this.now() - started,
              policy: this.retryPolicy,
            })
          : ({ retry: false, reason: 'retry disabled' } as const);
        if (!d.retry) throw err;
        await this.waitOrAbort(d.delayMs, opts.signal);
        if (opts.signal?.aborted) throw err;
        continue;
      }

      const resHeaders = headersToRecord(res.headers);
      let raw: string;
      try {
        raw = await res.text();
      } catch (cause) {
        throw toNetworkError(cause, timeoutMs, request, attempt);
      }
      const parsed = parseResponse<T>(resHeaders['content-type'], raw);

      if (res.ok && parsed.envelope?.success) {
        if (parsed.envelope.data === null) {
          throw new BookPrintApiError({
            status: res.status,
            message: `HTTP ${res.status} success 이지만 data 가 null`,
            errorCode: null,
            errors: [],
            fieldErrors: [],
            data: null,
            raw,
            headers: resHeaders,
            request,
            attempts: attempt,
          });
        }
        return {
          data: parsed.envelope.data,
          envelope: parsed.envelope,
          status: res.status,
          headers: resHeaders,
          replayed: (resHeaders['x-idempotent-replayed'] ?? '').toLowerCase() === 'true',
          requestId: resHeaders['x-idempotent-key'] ?? opts.idempotencyKey ?? null,
          attempts: attempt,
          durationMs: this.now() - started,
          request,
        };
      }

      const apiErr = toApiError(res.status, parsed, resHeaders, request, attempt);
      const d = canRetry
        ? decideRetry({
            attempt,
            status: res.status,
            errorCode: apiErr.errorCode,
            retryAfterSec: parseRetryAfter(resHeaders['retry-after'], this.now),
            elapsedMs: this.now() - started,
            policy: this.retryPolicy,
          })
        : ({ retry: false, reason: 'retry disabled' } as const);
      if (!d.retry) throw apiErr;
      await this.waitOrAbort(d.delayMs, opts.signal);
      if (opts.signal?.aborted) throw apiErr;
    }
  }

  private async waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) return;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms, signal), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  get<T>(
    path: string,
    query?: RequestOptions['query'],
    extra?: Partial<RequestOptions>,
  ): Promise<ApiResult<T>> {
    return this.request<T>({ method: 'GET', path, ...(query ? { query } : {}), ...extra });
  }

  async probe(path: string, opts: CallOptions = {}): Promise<ProbeResult> {
    const url = this.buildUrl(path, undefined);
    const request: RequestSummary = { method: 'GET', url, headers: {}, bodySummary: null };
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: combineSignals(opts.signal, AbortSignal.timeout(timeoutMs)),
      });
    } catch (cause) {
      throw toNetworkError(cause, timeoutMs, request, 1);
    }
    const headers = headersToRecord(res.headers);
    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        status: res.status,
        headers,
        errorCode: null,
        message: null,
        errors: [],
        fieldErrors: [],
        data: null,
        raw: '',
        request,
      };
    }
    const raw = await res.text();
    const env = parseResponse<unknown>(headers['content-type'], raw).envelope;
    return {
      status: res.status,
      headers,
      errorCode: env?.errorCode ?? null,
      message: env?.message ?? null,
      errors: Array.isArray(env?.errors) ? env.errors : [],
      fieldErrors: Array.isArray(env?.fieldErrors) ? env.fieldErrors : [],
      data: env?.data ?? null,
      raw,
      request,
    };
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    const u = new URL(`${this.baseUrl}${p}`);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private buildBody(opts: RequestOptions): {
    headers: Record<string, string>;
    body: FetchBody | undefined;
    summary: string | null;
  } {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.raw) {
      headers['Content-Type'] = opts.raw.contentType;
      if (opts.raw.contentLength !== undefined)
        headers['Content-Length'] = String(opts.raw.contentLength);
      return { headers, body: opts.raw.body, summary: opts.raw.summary };
    }
    if (opts.json !== undefined) {
      const text = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json; charset=utf-8';
      return { headers, body: text, summary: text };
    }
    if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
      headers['Content-Length'] = '0';
    }
    return { headers, body: undefined, summary: null };
  }
}

// ---------------------------------------------------------------- helpers

function toApiError(
  status: number,
  parsed: ParsedResponse<unknown>,
  headers: Record<string, string>,
  request: RequestSummary,
  attempts: number,
): BookPrintApiError {
  const env = parsed.envelope;
  const fieldErrors: FieldError[] = Array.isArray(env?.fieldErrors) ? env.fieldErrors : [];
  const message =
    env?.message ??
    (status >= 200 && status < 300
      ? `HTTP ${status} 이지만 success envelope 가 아님`
      : `HTTP ${status}`);
  return new BookPrintApiError({
    status,
    message,
    errorCode: env?.errorCode ?? null,
    errors: Array.isArray(env?.errors) ? env.errors : [],
    fieldErrors,
    data: env?.data ?? null,
    raw: parsed.raw,
    headers,
    request,
    attempts,
  });
}

function toNetworkError(
  cause: unknown,
  timeoutMs: number,
  request: RequestSummary,
  attempts: number,
): BookPrintNetworkError {
  if (cause instanceof Error && cause.name === 'TimeoutError')
    return new BookPrintTimeoutError(timeoutMs, request, attempts);
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new BookPrintNetworkError(`Network request failed: ${msg}`, request, { cause, attempts });
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await timersSetTimeout(ms, undefined, signal ? { signal } : {});
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
  }
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function combineSignals(caller: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}
