import type { Environment, FieldError } from '../bookprint/index.js';

export const STEP_ORDER = [
  'createBook',
  'uploadCover',
  'uploadContents',
  'finalize',
  'estimate',
  'createOrder',
] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** UNKNOWN = 요청은 보냈지만 응답을 못 받았다. 서버에 반영됐을 수 있다. FAILED = 서버가 거부했다. */
export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'UNKNOWN';

export interface JobError {
  status: number | null;
  errorCode: string | null;
  message: string;
  errors: string[];
  fieldErrors: FieldError[];
  /** 오류의 진단 객체 — 402 의 { required, balance, currency } 등 */
  data: unknown;
  /** JSON 이 아닌 응답의 원문 */
  raw: string | null;
}

export interface StepState {
  status: StepStatus;
  /** 책 생성·최종화·주문만 가진다(작업 생성 때 만든다). 업로드·견적은 null */
  idempotencyKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 마지막 성공 응답이 멱등 재현이었나 */
  replayed: boolean | null;
  error: JobError | null;
  /** 단계별 부가 정보 — 업로드한 파일 경로·크기, 서버가 측정한 규격 등 */
  detail: Record<string, unknown> | null;
}

export interface Shipping {
  recipientName: string;
  recipientPhone: string;
  postalCode: string;
  address1: string;
  address2?: string;
  memo?: string;
}

export interface JobInput {
  bookSpecUid: string;
  pageCount: number;
  title: string;
  coverPath?: string;
  contentsPath?: string;
  quantity?: number;
  shipping?: Shipping;
}

export interface LogRequest {
  /** HTTP 메서드. 서버를 부르기 전에 끝난 실패는 'LOCAL' */
  method: string;
  url: string;
  /** Authorization 은 없다 */
  headers: Record<string, string>;
  bodySummary: string | null;
}

export interface LogResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON 이면 envelope, 아니면 null */
  body: unknown;
  /** JSON 이 아닌 응답의 원문 */
  raw: string | null;
}

/** 단계마다 오간 요청·응답 원본 */
export interface LogEntry {
  step: StepName;
  at: string;
  attempt: number;
  ms: number;
  request: LogRequest;
  response: LogResponse | null;
  error: JobError | null;
  replayed: boolean;
}

export interface JobState {
  version: 1;
  id: string;
  env: Environment;
  createdAt: string;
  updatedAt: string;
  input: JobInput;
  bookUid: string | null;
  orderUid: string | null;
  steps: Record<StepName, StepState>;
  log: LogEntry[];
}

export interface NewJobOptions {
  env: Environment;
  now: () => Date;
  uuid: () => string;
  id?: string;
}

const EMPTY_STEP: StepState = {
  status: 'PENDING',
  idempotencyKey: null,
  startedAt: null,
  finishedAt: null,
  replayed: null,
  error: null,
  detail: null,
};

export function newJob(input: JobInput, opts: NewJobOptions): JobState {
  const at = opts.now();
  const id = opts.id ?? makeJobId(at, opts.uuid);
  const withKey = (): StepState => ({ ...EMPTY_STEP, idempotencyKey: opts.uuid() });
  return {
    version: 1,
    id,
    env: opts.env,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    input,
    bookUid: null,
    orderUid: null,
    steps: {
      createBook: withKey(),
      uploadCover: { ...EMPTY_STEP },
      uploadContents: { ...EMPTY_STEP },
      finalize: withKey(),
      estimate: { ...EMPTY_STEP },
      createOrder: withKey(),
    },
    log: [],
  };
}

/** 다음에 실행할 단계. 전부 DONE 이면 null */
export function nextStep(job: JobState): StepName | null {
  for (const s of STEP_ORDER) if (job.steps[s].status !== 'DONE') return s;
  return null;
}

/** PDF 교체 잠금 — 주문이 있거나 있을 수 있으면(createOrder 가 DONE·UNKNOWN·RUNNING) true */
export function isReplaceLocked(job: JobState): boolean {
  const s = job.steps.createOrder.status;
  return s === 'DONE' || s === 'UNKNOWN' || s === 'RUNNING';
}

function makeJobId(at: Date, uuid: () => string): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `j_${y}${m}${d}-${hh}${mm}-${uuid().slice(0, 8)}`;
}
