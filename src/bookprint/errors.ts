import type { FieldError } from './types.js';

/** 기록·표시용 요청 요약. Authorization 헤더는 들어 있지 않다 */
export interface RequestSummary {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  bodySummary: string | null;
}

/** 서버가 답했지만 실패. envelope 필드를 그대로 담는다 */
export class BookPrintApiError extends Error {
  override readonly name = 'BookPrintApiError';
  readonly status: number;
  /** 서버 errorCode. JSON 이 아닌 응답과 멱등 락 409 는 null */
  readonly errorCode: string | null;
  readonly errors: readonly string[];
  readonly fieldErrors: readonly FieldError[];
  /** 일부 오류의 진단 객체 — 402 의 { required, balance, currency } 등 */
  readonly data: unknown;
  /** 응답 본문 원문 */
  readonly raw: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly request: RequestSummary;
  /** 이 오류로 끝나기까지 보낸 시도 수 (재시도 포함) */
  readonly attempts: number;

  constructor(init: {
    status: number;
    message: string;
    errorCode: string | null;
    errors: readonly string[];
    fieldErrors: readonly FieldError[];
    data: unknown;
    raw: string;
    headers: Readonly<Record<string, string>>;
    request: RequestSummary;
    attempts?: number;
  }) {
    super(init.message);
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.errors = init.errors;
    this.fieldErrors = init.fieldErrors;
    this.data = init.data;
    this.raw = init.raw;
    this.headers = init.headers;
    this.request = init.request;
    this.attempts = init.attempts ?? 1;
  }

  /** 사용자에게 보일 한 줄 — errors[0] 우선, 없으면 message */
  userMessage(): string {
    return this.errors[0] ?? this.message;
  }

  fieldError(field: string): FieldError | undefined {
    return this.fieldErrors.find((fe) => fe.field === field);
  }
}

/** 요청이 서버에 닿지 못했거나 응답을 받지 못함. 서버에 반영됐는지 알 수 없다 */
export class BookPrintNetworkError extends Error {
  override readonly name: 'BookPrintNetworkError' | 'BookPrintTimeoutError' =
    'BookPrintNetworkError';
  readonly request: RequestSummary;
  readonly attempts: number;
  constructor(
    message: string,
    request: RequestSummary,
    options?: { cause?: unknown; attempts?: number },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.request = request;
    this.attempts = options?.attempts ?? 1;
  }
}

export class BookPrintTimeoutError extends BookPrintNetworkError {
  override readonly name = 'BookPrintTimeoutError' as const;
  readonly timeoutMs: number;
  constructor(timeoutMs: number, request: RequestSummary, attempts = 1) {
    super(`Request timed out after ${timeoutMs}ms`, request, { attempts });
    this.timeoutMs = timeoutMs;
  }
}
