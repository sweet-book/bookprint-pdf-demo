import { randomUUID } from 'node:crypto';
import {
  createBook as apiCreateBook,
  createOrder as apiCreateOrder,
  estimateOrder as apiEstimateOrder,
  finalizeBook as apiFinalizeBook,
  BookPrintApiError,
  type BookPrintClient,
  BookPrintNetworkError,
  type PdfKind,
  probePdf,
  uploadPdf,
} from '../bookprint/index.js';
import { FlowRuleError } from './errors.js';
import {
  isReplaceLocked,
  type JobState,
  nextStep,
  STEP_ORDER,
  type StepName,
  type StepState,
  type StepStatus,
} from './job.js';
import { logFailure, logProbe, logSuccess, maskDeep, toJobError } from './log.js';
import { type LocalPdfFile, openPdf, PdfPrecheckError } from './pdf.js';
import type { JobStore } from './store.js';

export interface StepDeps {
  client: BookPrintClient;
  store: JobStore;
  now: () => Date;
  /** 멱등 키 생성. 기본 randomUUID */
  uuid?: () => string;
  signal?: AbortSignal;
}

export class StepFailed extends Error {
  override readonly name = 'StepFailed';
  constructor(
    readonly step: StepName,
    readonly job: JobState,
    override readonly cause: unknown,
  ) {
    super(`${step}: ${toJobError(cause).message}`, { cause });
  }
}

function needsNewIdempotencyKey(s: StepState): boolean {
  if (s.status !== 'FAILED' || s.idempotencyKey === null) return false;
  return s.error?.errorCode === 'ERR_IDEMPOTENCY_KEY_MISMATCH';
}

function requireIdempotencyKey(job: JobState, step: StepName): void {
  const key = job.steps[step].idempotencyKey;
  if (typeof key !== 'string' || key === '') {
    throw new FlowRuleError(`${step} 멱등 키가 없다 — newJob() 으로 만든 작업이 아니다`, {
      errorCode: 'ERR_IDEMPOTENCY_KEY_MISSING',
    });
  }
}

function sig(deps: StepDeps): { signal?: AbortSignal } {
  return deps.signal ? { signal: deps.signal } : {};
}

function failNoBook(
  job: JobState,
  step: StepName,
  deps: StepDeps,
  startedAt: Date,
): Promise<never> {
  return fail(
    job,
    step,
    new FlowRuleError('책이 아직 없다 — createBook 이 먼저다'),
    deps,
    startedAt,
  );
}

function isInconclusive(err: unknown): boolean {
  if (err instanceof BookPrintNetworkError) return true;
  if (!(err instanceof BookPrintApiError)) return false;
  if (err.status >= 200 && err.status < 300) return true;
  return err.status >= 500 || (err.status === 409 && err.errorCode === null);
}

function isDefinite(err: unknown): boolean {
  return err instanceof BookPrintApiError && err.status >= 400 && err.status < 500;
}

const priorStatus = new WeakMap<StepState, StepStatus>();

async function begin(job: JobState, step: StepName, deps: StepDeps): Promise<Date> {
  const at = deps.now();
  const s = job.steps[step];
  priorStatus.set(s, s.status);
  if (needsNewIdempotencyKey(s)) {
    s.idempotencyKey = (deps.uuid ?? randomUUID)();
  }
  s.status = 'RUNNING';
  s.startedAt = at.toISOString();
  s.error = null;
  s.detail = null;
  job.updatedAt = at.toISOString();
  await deps.store.save(job);
  return at;
}

async function done(
  job: JobState,
  step: StepName,
  deps: StepDeps,
  patch: { replayed: boolean | null; detail: Record<string, unknown> | null },
): Promise<JobState> {
  const at = deps.now();
  const s = job.steps[step];
  s.status = 'DONE';
  s.finishedAt = at.toISOString();
  s.replayed = patch.replayed;
  s.detail = maskDeep(patch.detail);
  s.error = null;
  job.updatedAt = at.toISOString();
  await deps.store.save(job);
  return job;
}

async function fail(
  job: JobState,
  step: StepName,
  err: unknown,
  deps: StepDeps,
  startedAt: Date,
  keepStatus?: StepStatus,
): Promise<never> {
  const at = deps.now();
  const s = job.steps[step];
  const prior = priorStatus.get(s);
  const wasSent = prior === 'UNKNOWN' || prior === 'RUNNING';
  const originalExists =
    wasSent && err instanceof BookPrintApiError && err.errorCode === 'ERR_IDEMPOTENCY_KEY_MISMATCH';
  const unknown = isInconclusive(err) || originalExists || (wasSent && !isDefinite(err));
  s.status = keepStatus ?? (unknown ? 'UNKNOWN' : 'FAILED');
  s.finishedAt = at.toISOString();
  s.error = toJobError(err);
  logFailure(job, step, err, at, at.getTime() - startedAt.getTime());
  job.updatedAt = at.toISOString();
  await deps.store.save(job);
  throw new StepFailed(step, job, err);
}

/** 1단계 — 책 생성 (POST /books) */
export async function createBook(job: JobState, deps: StepDeps): Promise<JobState> {
  const step: StepName = 'createBook';
  requireIdempotencyKey(job, step);
  const startedAt = await begin(job, step, deps);
  const key = job.steps[step].idempotencyKey as string;
  try {
    const res = await apiCreateBook(
      deps.client,
      {
        title: job.input.title,
        bookSpecUid: job.input.bookSpecUid,
        creationType: 'PDF_UPLOAD',
        pageCount: job.input.pageCount,
        externalRef: job.id,
      },
      key,
      sig(deps),
    );
    job.bookUid = res.data.bookUid;
    logSuccess(job, step, res, deps.now());
    return done(job, step, deps, {
      replayed: res.replayed,
      detail: { pageMeta: res.data.pageMeta },
    });
  } catch (err) {
    return fail(job, step, err, deps, startedAt);
  }
}

async function uploadStep(kind: PdfKind, job: JobState, deps: StepDeps): Promise<JobState> {
  const step: StepName = kind === 'cover' ? 'uploadCover' : 'uploadContents';
  const path = kind === 'cover' ? job.input.coverPath : job.input.contentsPath;
  const prior = job.steps[step].status;
  const maySent = prior === 'UNKNOWN' || prior === 'RUNNING';
  const pendingReplace = readPendingReplace(job.steps[step]);
  const startedAt = await begin(job, step, deps);
  const keep = maySent ? prior : undefined;
  if (!job.bookUid) {
    return fail(
      job,
      step,
      new FlowRuleError('책이 아직 없다 — createBook 이 먼저다'),
      deps,
      startedAt,
      keep,
    );
  }
  if (!path && !pendingReplace) {
    return fail(
      job,
      step,
      new FlowRuleError(`${kind === 'cover' ? '표지' : '내지'} PDF 경로가 없다 (--${kind})`),
      deps,
      startedAt,
      keep,
    );
  }
  let file: LocalPdfFile;
  try {
    file = await openPdf(pendingReplace ?? (path as string));
  } catch (err) {
    return fail(job, step, err, deps, startedAt, keep);
  }

  if (maySent) {
    const t0 = deps.now();
    let probed: Awaited<ReturnType<typeof probePdf>>;
    try {
      probed = await probePdf(deps.client, job.bookUid, kind, sig(deps));
    } catch (err) {
      return fail(job, step, err, deps, startedAt, prior);
    }
    logProbe(job, step, probed.probe, deps.now(), deps.now().getTime() - t0.getTime());
    if (probed.state === 'present') {
      if (pendingReplace) {
        return putReplacement(job, step, kind, file, deps, startedAt, prior);
      }
      return done(job, step, deps, {
        replayed: false,
        detail: { path: file.path, size: file.size, recovered: 'present' },
      });
    }
  }

  try {
    const res = await uploadPdf(deps.client, job.bookUid, kind, file, sig(deps));
    logSuccess(job, step, res, deps.now());
    return done(job, step, deps, {
      replayed: false,
      detail: {
        path: file.path,
        size: file.size,
        pdfSizeMm: res.data.pdfSizeMm,
        valid: res.data.valid,
        warnings: res.data.warnings,
        ...(maySent ? { recovered: 'reuploaded' } : {}),
      },
    });
  } catch (err) {
    if (
      err instanceof BookPrintApiError &&
      err.status === 409 &&
      err.errorCode === 'ERR_CONFLICT'
    ) {
      logFailure(job, step, err, deps.now(), deps.now().getTime() - startedAt.getTime());
      return done(job, step, deps, {
        replayed: false,
        detail: { path: file.path, size: file.size, alreadyUploaded: true },
      });
    }
    return fail(job, step, err, deps, startedAt);
  }
}

/** 2단계 — 표지 PDF 업로드 */
export const uploadCover = (job: JobState, deps: StepDeps): Promise<JobState> =>
  uploadStep('cover', job, deps);
/** 3단계 — 내지 PDF 업로드 */
export const uploadContents = (job: JobState, deps: StepDeps): Promise<JobState> =>
  uploadStep('contents', job, deps);

/** 올린 PDF 를 PUT 으로 교체한다. 주문이 걸린 책이면 FlowRuleError */
export async function replacePdf(
  job: JobState,
  deps: StepDeps,
  kind: PdfKind,
  path: string,
): Promise<JobState> {
  if (isReplaceLocked(job)) {
    throw new FlowRuleError('주문이 이미 생성된 책의 PDF 는 교체할 수 없습니다 (앱 잠금)');
  }
  if (!job.bookUid) throw new FlowRuleError('책이 아직 없다');
  const step: StepName = kind === 'cover' ? 'uploadCover' : 'uploadContents';
  const prior = job.steps[step].status;
  const startedAt = await begin(job, step, deps);
  let file: LocalPdfFile;
  try {
    file = await openPdf(path);
  } catch (err) {
    return fail(job, step, err, deps, startedAt, prior);
  }
  return putReplacement(job, step, kind, file, deps, startedAt, prior);
}

function readPendingReplace(s: StepState): string | undefined {
  const p = s.detail?.pendingReplace;
  return typeof p === 'string' && p !== '' ? p : undefined;
}

async function putReplacement(
  job: JobState,
  step: StepName,
  kind: PdfKind,
  file: LocalPdfFile,
  deps: StepDeps,
  startedAt: Date,
  prior: StepStatus,
): Promise<JobState> {
  try {
    const res = await uploadPdf(deps.client, job.bookUid as string, kind, file, {
      replace: true,
      ...sig(deps),
    });
    if (kind === 'cover') job.input.coverPath = file.path;
    else job.input.contentsPath = file.path;
    logSuccess(job, step, res, deps.now());
    return done(job, step, deps, {
      replayed: false,
      detail: { path: file.path, size: file.size, pdfSizeMm: res.data.pdfSizeMm, replaced: true },
    });
  } catch (err) {
    if (isInconclusive(err)) {
      job.steps[step].detail = { pendingReplace: file.path };
      return fail(job, step, err, deps, startedAt, 'UNKNOWN');
    }
    return fail(job, step, err, deps, startedAt, prior);
  }
}

/** 4단계 — 최종화 (POST /books/{uid}/finalization) */
export async function finalize(job: JobState, deps: StepDeps): Promise<JobState> {
  const step: StepName = 'finalize';
  requireIdempotencyKey(job, step);
  const startedAt = await begin(job, step, deps);
  if (!job.bookUid) return failNoBook(job, step, deps, startedAt);
  const key = job.steps[step].idempotencyKey as string;
  try {
    const res = await apiFinalizeBook(deps.client, job.bookUid, key, sig(deps));
    logSuccess(job, step, res, deps.now());
    return done(job, step, deps, {
      replayed: res.replayed,
      detail: { result: res.data.result, finalizedAt: res.data.finalizedAt },
    });
  } catch (err) {
    return fail(job, step, err, deps, startedAt);
  }
}

/** 견적 단계의 detail */
export interface EstimateDetail {
  quantity: number;
  productAmount: number;
  shippingFee: number;
  packagingFee: number;
  totalAmount: number;
  /** 실제 차감액 — VAT 포함, 10원 절사 */
  paidCreditAmount: number;
  creditBalance: number;
  creditSufficient: boolean;
  currency: string;
}

export function getEstimate(job: JobState): EstimateDetail | null {
  const d = job.steps.estimate.detail;
  return d && typeof d.paidCreditAmount === 'number' ? (d as unknown as EstimateDetail) : null;
}

/**
 * 5단계 — 견적 (POST /orders/estimate).
 * 잔액이 모자라면 FAILED(ERR_INSUFFICIENT_CREDIT)로 멈추고 주문하지 않는다.
 */
export async function estimate(job: JobState, deps: StepDeps): Promise<JobState> {
  const step: StepName = 'estimate';
  const startedAt = await begin(job, step, deps);
  if (!job.bookUid) return failNoBook(job, step, deps, startedAt);
  const quantity = job.input.quantity ?? 1;
  try {
    const res = await apiEstimateOrder(
      deps.client,
      { items: [{ bookUid: job.bookUid, quantity }] },
      sig(deps),
    );
    logSuccess(job, step, res, deps.now());
    const e = res.data;
    const detail: EstimateDetail = {
      quantity,
      productAmount: e.productAmount,
      shippingFee: e.shippingFee,
      packagingFee: e.packagingFee,
      totalAmount: e.totalAmount,
      paidCreditAmount: e.paidCreditAmount,
      creditBalance: e.creditBalance,
      creditSufficient: e.creditSufficient,
      currency: e.currency,
    };
    if (!e.creditSufficient) {
      job.steps[step].detail = maskDeep({ ...detail });
      return fail(
        job,
        step,
        new FlowRuleError(
          `충전금 부족 — 필요 ${e.paidCreditAmount} ${e.currency}, 잔액 ${e.creditBalance} ${e.currency} (부족 ${e.paidCreditAmount - e.creditBalance}). 주문을 보내지 않았다`,
          {
            errorCode: 'ERR_INSUFFICIENT_CREDIT',
            data: { required: e.paidCreditAmount, balance: e.creditBalance, currency: e.currency },
          },
        ),
        deps,
        startedAt,
      );
    }
    return done(job, step, deps, { replayed: false, detail: { ...detail } });
  } catch (err) {
    return fail(job, step, err, deps, startedAt);
  }
}

/** 6단계 — 주문 (POST /orders). 충전금이 차감된다 */
export async function createOrder(job: JobState, deps: StepDeps): Promise<JobState> {
  const step: StepName = 'createOrder';
  requireIdempotencyKey(job, step);
  const startedAt = await begin(job, step, deps);
  if (!job.bookUid) return failNoBook(job, step, deps, startedAt);
  if (!job.input.shipping) {
    return fail(
      job,
      step,
      new FlowRuleError('배송지가 없다 (--ship <json>)', { errorCode: 'ERR_SHIPPING_MISSING' }),
      deps,
      startedAt,
    );
  }
  const key = job.steps[step].idempotencyKey as string;
  try {
    const res = await apiCreateOrder(
      deps.client,
      {
        items: [{ bookUid: job.bookUid, quantity: job.input.quantity ?? 1 }],
        shipping: job.input.shipping,
        externalRef: job.id,
      },
      key,
      sig(deps),
    );
    job.orderUid = res.data.orderUid;
    logSuccess(job, step, res, deps.now());
    return done(job, step, deps, {
      replayed: res.replayed,
      detail: {
        orderStatus: res.data.orderStatus,
        totalAmount: res.data.totalAmount,
        paidCreditAmount: res.data.paidCreditAmount,
        creditBalanceAfter: res.data.creditBalanceAfter,
        isTest: res.data.isTest,
      },
    });
  } catch (err) {
    if (err instanceof BookPrintApiError && err.status === 402) {
      job.steps.estimate.status = 'PENDING';
    }
    return fail(job, step, err, deps, startedAt);
  }
}

/**
 * 고친 PDF 를 받는다 (`resume --cover/--contents`).
 * 서버에 이미 올라가 있으면 PUT 으로 교체하고 'replaced', 아니면 경로만 바꾸고 'queued' — 다음 업로드 단계가 올린다.
 */
export async function supplyNewPdf(
  job: JobState,
  deps: StepDeps,
  kind: PdfKind,
  path: string,
): Promise<'replaced' | 'queued'> {
  if (isReplaceLocked(job)) {
    throw new FlowRuleError('주문이 이미 생성된 책의 PDF 는 교체할 수 없습니다 (앱 잠금)');
  }
  const step: StepName = kind === 'cover' ? 'uploadCover' : 'uploadContents';
  const status = job.steps[step].status;
  const setPath = (): void => {
    if (kind === 'cover') job.input.coverPath = path;
    else job.input.contentsPath = path;
  };

  if (status === 'DONE') {
    await replacePdf(job, deps, kind, path);
    return 'replaced';
  }
  if (status === 'UNKNOWN' || status === 'RUNNING') {
    if (!job.bookUid) throw new FlowRuleError('책이 아직 없다');
    const probed = await probePdf(deps.client, job.bookUid, kind, sig(deps));
    logProbe(job, step, probed.probe, deps.now(), 0);
    if (probed.state === 'present') {
      await replacePdf(job, deps, kind, path);
      return 'replaced';
    }
    setPath();
    job.steps[step].status = 'PENDING';
    job.updatedAt = deps.now().toISOString();
    await deps.store.save(job);
    return 'queued';
  }
  setPath();
  job.updatedAt = deps.now().toISOString();
  await deps.store.save(job);
  return 'queued';
}

export { FlowRuleError, PdfPrecheckError };

type StepFn = (job: JobState, deps: StepDeps) => Promise<JobState>;

const STEP_FNS: Record<StepName, StepFn> = {
  createBook,
  uploadCover,
  uploadContents,
  finalize,
  estimate,
  createOrder,
};

export interface RunOptions {
  /** 이 단계까지만 실행하고 멈춘다 (포함). 이미 지난 단계면 아무것도 실행하지 않는다 */
  until?: StepName;
}

/** 견적 유효 시간(ms). 이보다 오래된 견적은 주문 전에 다시 뽑는다 */
export const ESTIMATE_TTL_MS = 10 * 60_000;

/** DONE 인 견적이 낡았는가. finishedAt 이 없으면 낡은 것으로 본다 */
export function isEstimateStale(job: JobState, now: Date): boolean {
  const s = job.steps.estimate;
  if (s.status !== 'DONE') return false;
  const at = s.finishedAt ? Date.parse(s.finishedAt) : Number.NaN;
  return !Number.isFinite(at) || now.getTime() - at > ESTIMATE_TTL_MS;
}

/**
 * 다음 단계부터 순서대로 실행하고, 첫 실패에서 StepFailed 를 던진다. DONE 인 단계는 건너뛴다.
 * 반환값은 언제나 job 이다. 끝났는지는 nextStep(job) 으로 안다 (null = 완주).
 */
export async function runFlow(
  job: JobState,
  deps: StepDeps,
  opts: RunOptions = {},
): Promise<JobState> {
  const limit = opts.until ? STEP_ORDER.indexOf(opts.until) : STEP_ORDER.length - 1;
  for (;;) {
    let step = nextStep(job);
    const order = job.steps.createOrder.status;
    const orderMayExist = order === 'UNKNOWN' || order === 'RUNNING';
    if (step === 'createOrder' && !orderMayExist && isEstimateStale(job, deps.now())) {
      job.steps.estimate.status = 'PENDING';
      step = 'estimate';
    }
    if (step === null) return job;
    if (STEP_ORDER.indexOf(step) > limit) return job;
    await STEP_FNS[step](job, deps);
    if (step === opts.until) return job;
  }
}
