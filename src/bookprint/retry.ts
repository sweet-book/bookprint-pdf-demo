export interface RetryPolicy {
  /** 첫 시도 포함 최대 시도 수 */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** ±비율. 0.2 = ±20% */
  jitter: number;
  /** 요청 하나에 허용하는 전체 시간(ms) */
  budgetMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.2,
  budgetMs: 120_000,
};

export type RetryDecision =
  | { retry: true; delayMs: number; reason: string }
  | { retry: false; reason: string };

export interface RetryInput {
  /** 방금 끝난 시도 번호 (1부터) */
  attempt: number;
  /** null = 응답 없음(네트워크·타임아웃) */
  status: number | null;
  errorCode: string | null;
  /** Retry-After 헤더(초). 없으면 null */
  retryAfterSec: number | null;
  /** 첫 시도 시작부터 지금까지(ms) */
  elapsedMs: number;
  policy?: RetryPolicy;
  /** 테스트용 난수 주입 */
  random?: () => number;
}

export function isRetryable(status: number | null, errorCode: string | null): boolean {
  if (status === null) return true;
  if (status === 429) return true;
  if (status === 500) return errorCode === 'ERR_INTERNAL_ERROR' || errorCode === null;
  if (status === 409) return errorCode === null;
  return false;
}

export function decideRetry(input: RetryInput): RetryDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  const random = input.random ?? Math.random;

  if (!isRetryable(input.status, input.errorCode)) {
    return {
      retry: false,
      reason: `not retryable: ${input.status ?? 'no response'} ${input.errorCode ?? ''}`.trim(),
    };
  }
  if (input.attempt >= policy.maxAttempts) {
    return { retry: false, reason: `max attempts (${policy.maxAttempts}) reached` };
  }

  let delayMs: number;
  if (input.retryAfterSec !== null && input.retryAfterSec >= 0) {
    delayMs = input.retryAfterSec * 1000;
  } else {
    const exp = Math.min(policy.baseDelayMs * 2 ** (input.attempt - 1), policy.maxDelayMs);
    const spread = exp * policy.jitter;
    delayMs = Math.round(exp - spread + random() * 2 * spread);
  }

  if (input.elapsedMs + delayMs > policy.budgetMs) {
    return {
      retry: false,
      reason: `budget exceeded: waiting ${delayMs}ms would pass ${policy.budgetMs}ms — resume later`,
    };
  }
  return { retry: true, delayMs, reason: input.retryAfterSec !== null ? 'Retry-After' : 'backoff' };
}

/** Retry-After 헤더(초 또는 HTTP-date)를 초로. 못 읽으면 null */
export function parseRetryAfter(
  value: string | undefined,
  now: () => number = Date.now,
): number | null {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, sec);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now()) / 1000));
}
