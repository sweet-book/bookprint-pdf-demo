import type { ApiResult, ProbeResult, RequestSummary } from '../bookprint/index.js';
import { BookPrintApiError, BookPrintNetworkError } from '../bookprint/index.js';
import { FlowRuleError } from './errors.js';
import type { JobError, JobState, LogEntry, StepName } from './job.js';

/** API 키 형식 SB + 10자 + '.' + 32자 */
const KEY_PATTERN = /SB[A-Za-z0-9]{10}\.[A-Za-z0-9_-]{32}/g;

export function maskSecrets(text: string): string {
  return text.replace(KEY_PATTERN, (m) => `${m.slice(0, 12)}.****`);
}

/** 값 안의 문자열을 전부 마스킹한다. 직렬화할 수 없는 값은 null */
export function maskDeep<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(maskSecrets(JSON.stringify(value))) as T;
  } catch {
    return null as unknown as T;
  }
}

function maskRecord(rec: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === 'authorization') continue;
    out[k] = maskSecrets(v);
  }
  return out;
}

function fromRequest(req: RequestSummary): LogEntry['request'] {
  return {
    method: req.method,
    url: req.url,
    headers: maskRecord(req.headers),
    bodySummary: req.bodySummary === null ? null : maskSecrets(req.bodySummary),
  };
}

export function toJobError(err: unknown): JobError {
  if (err instanceof BookPrintApiError) {
    return {
      status: err.status,
      errorCode: err.errorCode,
      message: maskSecrets(err.message),
      errors: err.errors.map(maskSecrets),
      fieldErrors: maskDeep([...err.fieldErrors]),
      data: maskDeep(err.data),
      raw: err.errorCode === null ? maskSecrets(err.raw) : null,
    };
  }
  if (err instanceof BookPrintNetworkError) {
    return {
      status: null,
      errorCode: null,
      message: maskSecrets(err.message),
      errors: [],
      fieldErrors: [],
      data: null,
      raw: null,
    };
  }
  if (err instanceof FlowRuleError) {
    return {
      status: null,
      errorCode: err.errorCode,
      message: maskSecrets(err.message),
      errors: [],
      fieldErrors: [],
      data: maskDeep(err.data),
      raw: null,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: null,
    errorCode: null,
    message: maskSecrets(message),
    errors: [],
    fieldErrors: [],
    data: null,
    raw: null,
  };
}

export function logSuccess(job: JobState, step: StepName, res: ApiResult<unknown>, at: Date): void {
  job.log.push({
    step,
    at: at.toISOString(),
    attempt: res.attempts,
    ms: res.durationMs,
    request: fromRequest(res.request),
    response: {
      status: res.status,
      headers: maskRecord(res.headers),
      body: maskDeep(res.envelope),
      raw: null,
    },
    error: null,
    replayed: res.replayed,
  });
}

export function logFailure(
  job: JobState,
  step: StepName,
  err: unknown,
  at: Date,
  ms: number,
): void {
  const request: RequestSummary =
    err instanceof BookPrintApiError || err instanceof BookPrintNetworkError
      ? err.request
      : { method: 'LOCAL', url: '', headers: {}, bodySummary: null };
  const attempts =
    err instanceof BookPrintApiError || err instanceof BookPrintNetworkError ? err.attempts : 1;
  const response =
    err instanceof BookPrintApiError
      ? {
          status: err.status,
          headers: maskRecord(err.headers),
          body: err.errorCode !== null ? maskDeep(safeJson(err.raw)) : null,
          raw: err.errorCode === null ? maskSecrets(err.raw) : null,
        }
      : null;
  job.log.push({
    step,
    at: at.toISOString(),
    attempt: attempts,
    ms,
    request: fromRequest(request),
    response,
    error: toJobError(err),
    replayed: false,
  });
}

export function logProbe(
  job: JobState,
  step: StepName,
  r: ProbeResult,
  at: Date,
  ms: number,
): void {
  job.log.push({
    step,
    at: at.toISOString(),
    attempt: 1,
    ms,
    request: fromRequest(r.request),
    response: {
      status: r.status,
      headers: maskRecord(r.headers),
      body: r.errorCode
        ? maskDeep({ errorCode: r.errorCode, message: r.message, errors: r.errors })
        : null,
      raw: null,
    },
    error: null,
    replayed: false,
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
