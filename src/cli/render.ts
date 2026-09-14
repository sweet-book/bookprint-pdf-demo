import type { BookSpec, CalculatedSize } from '../bookprint/index.js';
import type {
  EstimateDetail,
  JobState,
  JobSummary,
  LogEntry,
  ShippingWarning,
  StepName,
} from '../flow/index.js';
import { maskSecrets, STEP_ORDER } from '../flow/index.js';

const CONTROL_PATTERN = /\p{Cc}/gu; // C0(00~1F) · DEL(7F) · C1(80~9F)

/** 제어 문자를 눈에 보이는 \xNN 으로 바꾼다 (줄바꿈·탭은 그대로) */
export function safeForTerminal(text: string): string {
  return text.replace(CONTROL_PATTERN, (c) => {
    if (c === '\n' || c === '\t') return c;
    return `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

function say(line: string): void {
  console.log(safeForTerminal(line));
}

function sayErr(line: string): void {
  console.error(safeForTerminal(line));
}

const STEP_LABEL: Record<StepName, string> = {
  createBook: '책 생성',
  uploadCover: '표지 PDF 업로드',
  uploadContents: '내지 PDF 업로드',
  finalize: '최종화',
  estimate: '견적',
  createOrder: '주문',
};

export function stepIndex(step: StepName): string {
  return `[${STEP_ORDER.indexOf(step) + 1}/${STEP_ORDER.length}]`;
}

export function printLogEntry(
  job: JobState,
  entry: LogEntry,
  index: number,
  verbose: boolean,
): void {
  say(`${stepIndex(entry.step)} ${STEP_LABEL[entry.step]}`);
  if (entry.request.method === 'LOCAL') {
    say('  · 서버 호출 없음 — 로컬 검사에서 멈춤');
  } else {
    const path = safePath(entry.request.url);
    say(
      `  → ${entry.request.method} ${path}${entry.request.bodySummary ? `   ${truncate(entry.request.bodySummary, 90)}` : ''}`,
    );
  }
  if (entry.response) {
    const replay = entry.replayed ? '  (멱등 재현)' : '';
    const tries = entry.attempt > 1 ? `  ${entry.attempt}회 시도` : '';
    say(`  ← ${entry.response.status}  ${(entry.ms / 1000).toFixed(1)}s${tries}${replay}`);
  }
  if (entry.error) {
    say(
      `  ✗ ${entry.error.errorCode ?? (entry.request.method === 'LOCAL' ? '로컬 검사' : entry.error.status === null ? '응답 없음' : `HTTP ${entry.error.status}`)}: ${entry.error.message}`,
    );
    for (const e of entry.error.errors) say(`    - ${e}`);
    for (const fe of entry.error.fieldErrors)
      say(`    - ${fe.field} (${fe.constraint ?? '-'}): ${fe.message}`);
  }
  say(`     원본: jobs/${job.id}.json#log[${index}]`);
  if (verbose && entry.response) {
    say(indent(JSON.stringify(entry.response.body ?? entry.response.raw, null, 2), 5));
  }
}

export function printJobStatus(job: JobState, verbose: boolean): void {
  say(`작업 ${job.id}  env=${job.env}  책=${job.bookUid ?? '-'}  주문=${job.orderUid ?? '-'}`);
  say(`  판형 ${job.input.bookSpecUid}  ${job.input.pageCount}p  "${job.input.title}"`);
  for (const s of STEP_ORDER) {
    const st = job.steps[s];
    const key = st.idempotencyKey ? `  key=${st.idempotencyKey.slice(0, 8)}…` : '';
    say(
      `  ${stepIndex(s)} ${pad(STEP_LABEL[s], 16)} ${pad(st.status, 8)}${key}${st.replayed ? '  (재현)' : ''}`.trimEnd(),
    );
  }
  if (job.log.length > 0) {
    say('기록');
    job.log.forEach((e, i) => {
      printLogEntry(job, e, i, verbose);
    });
  }
}

export function printJobs(rows: JobSummary[]): void {
  if (rows.length === 0) {
    say('작업 없음. `run` 으로 시작하세요.');
    return;
  }
  say(
    [
      pad('id', 26),
      pad('env', 8),
      pad('다음 단계', 14),
      pad('책', 16),
      pad('주문', 16),
      '갱신',
    ].join(' '),
  );
  for (const r of rows) {
    say(
      [
        pad(r.id, 26),
        pad(r.env, 8),
        pad(r.next, 14),
        pad(r.bookUid ?? '-', 16),
        pad(r.orderUid ?? '-', 16),
        r.updatedAt,
      ].join(' '),
    );
  }
}

export function printSpecs(specs: BookSpec[]): void {
  say(
    [pad('판형', 24), pad('커버', 10), pad('내지(mm)', 12), pad('페이지', 18), '기본가'].join(' '),
  );
  for (const s of specs) {
    say(
      [
        pad(s.bookSpecUid, 24),
        pad(s.coverType, 10),
        pad(`${s.innerTrimWidthMm}×${s.innerTrimHeightMm}`, 12),
        pad(`${s.pageMin}~${s.pageMax} (${s.pageIncrement}p 단위)`, 18),
        s.priceBase === null ? '-' : `${won(s.priceBase)} ${s.priceCurrency ?? ''}`,
      ].join(' '),
    );
  }
}

export function printCalculatedSize(c: CalculatedSize): void {
  say(
    `${c.bookSpecUid} ${c.pages}p — 표지 PDF ${c.coverWidthMm}×${c.coverHeightMm}mm (책등 ${c.spineWidthMm}mm) · 내지 PDF ${c.innerWidthMm}×${c.innerHeightMm}mm · 허용 오차 ±${c.pdfToleranceMm}mm`,
  );
  say('  표지는 제본과 무관하게 항상 펼침면 1페이지(뒤표지+책등+앞표지). 내지는 pageCount 장.');
}

export function printPdfHelp(bookSpecUid: string, pageCount: number): void {
  say('');
  say('규격에 맞는 PDF 를 얻는 길');
  say(`  샘플    fixtures/ 에 SQUAREBOOK_HC · PHOTOBOOK_A4_SC 24p 표지·내지가 있다`);
  say(`  규격    npm run cli -- specs --spec ${bookSpecUid} --pages ${pageCount}   (표지·내지 mm)`);
  say('  제작    https://api.sweetbook.com/pdf-guideline/   (재단·책등·여백 — 디자이너용)');
}

export function printError(message: string, hint?: string): void {
  sayErr(`오류: ${maskSecrets(message)}`);
  if (hint) sayErr(`  → ${maskSecrets(hint)}`);
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/v1/, '');
  } catch {
    return url;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 터미널에서 차지하는 칸 수. 한글·한자·가나는 두 칸 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

/** 표시 칸 수 기준 padEnd. 이미 넘치면 자르지 않는다 */
function pad(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function indent(s: string, n: number): string {
  const margin = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => margin + l)
    .join('\n');
}

const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');

export function printEstimate(e: EstimateDetail, env: JobState['env']): void {
  const after = e.creditBalance - e.paidCreditAmount;
  say('');
  say(
    `  견적  상품 ${won(e.productAmount)} + 배송 ${won(e.shippingFee)}${e.packagingFee ? ` + 포장 ${won(e.packagingFee)}` : ''} = ${won(e.totalAmount)} ${e.currency}  (${e.quantity}권)`,
  );
  say(`        → 충전금 차감 ${won(e.paidCreditAmount)} ${e.currency} (VAT 포함, 10원 절사)`);
  say(
    `  잔액  ${won(e.creditBalance)} → ${won(after)}   ${e.creditSufficient ? '충분' : `부족 (${won(-after)} 모자람)`}`,
  );
  if (env === 'sandbox') {
    say('  [sandbox] 실제 인쇄·배송 없음. 주문은 PDF_READY 에서 멈춥니다.');
  } else {
    say('  [live] 실제 인쇄·배송·과금됩니다.');
  }
  say('');
}

export function printOrderResult(job: JobState): void {
  const d = job.steps.createOrder.detail ?? {};
  const status = typeof d.orderStatus === 'string' ? d.orderStatus : '-';
  const paid = typeof d.paidCreditAmount === 'number' ? won(d.paidCreditAmount) : '-';
  const after = typeof d.creditBalanceAfter === 'number' ? won(d.creditBalanceAfter) : '-';
  say('');
  say(
    `주문 ${job.orderUid} 생성 — 상태 ${status}, 차감 ${paid}, 잔액 ${after}${job.steps.createOrder.replayed ? '  (멱등 재현 — 이미 있던 주문)' : ''}`,
  );
  say(`  원본: jobs/${job.id}.json`);
}

export function printShippingWarnings(warnings: ShippingWarning[]): void {
  say('');
  say('배송지 확인 — 서버는 이 형식을 검사하지 않습니다. 틀리면 그대로 인쇄·배송됩니다.');
  for (const w of warnings) say(`  ! ${w.field}: ${w.message}`);
  say('');
}
