import type { ApiResult, BookPrintClient, CallOptions, ProbeResult } from '../client.js';
import { BookPrintApiError } from '../errors.js';
import { buildFileMultipart } from '../multipart.js';
import type { PageMeta } from '../types.js';

export type PdfKind = 'cover' | 'contents';

export interface PdfUploadFile {
  filename: string;
  size: number;
  /** 부를 때마다 새 스트림을 연다 */
  open: () => AsyncIterable<Uint8Array>;
}

/** POST·PUT /books/{uid}/pdf-{kind} 응답 */
export interface UploadPdfResponse {
  bookUid: string;
  kind: PdfKind;
  valid: boolean;
  pdfSizeMm: { width: number; height: number };
  messages: string[];
  warnings: string[];
  /** 정수 1 DRAFT / 2 FINALIZED. 검증 실패 시 null 일 수 있다 */
  bookStatus: number | null;
  url: string | null;
  pageMeta: PageMeta;
}

export interface UploadPdfOptions {
  /** true = PUT 교체(없으면 404). false = POST 신규(있으면 409) */
  replace?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** POST(replace 면 PUT) /books/{uid}/pdf-{kind} — 표지·내지 PDF 업로드. 재시도하지 않는다 */
export function uploadPdf(
  client: BookPrintClient,
  bookUid: string,
  kind: PdfKind,
  file: PdfUploadFile,
  opts: UploadPdfOptions = {},
): Promise<ApiResult<UploadPdfResponse>> {
  const mp = buildFileMultipart({
    fieldName: 'file',
    filename: file.filename,
    contentType: 'application/pdf',
    size: file.size,
    open: file.open,
  });
  return client.request<UploadPdfResponse>({
    method: opts.replace ? 'PUT' : 'POST',
    path: `/books/${encodeURIComponent(bookUid)}/pdf-${kind}`,
    raw: {
      body: mp.body,
      contentType: mp.contentType,
      contentLength: mp.contentLength,
      summary: `multipart file=${file.filename} (${formatBytes(file.size)})`,
    },
    retry: false,
    timeoutMs:
      opts.timeoutMs ?? Math.max(60_000, Math.ceil(file.size / 1_000_000) * 1_000 + 30_000),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** probePdf 결과. present = 올라가 있다(200), absent = 없다(404 ERR_PDF_NOT_UPLOADED) */
export interface PdfProbe {
  state: 'present' | 'absent';
  /** 기록용 원본. 본문은 없다 */
  probe: ProbeResult;
}

/** 업로드 여부 확인. 200·404 ERR_PDF_NOT_UPLOADED 외의 응답은 BookPrintApiError 로 던진다 */
export async function probePdf(
  client: BookPrintClient,
  bookUid: string,
  kind: PdfKind,
  opts: CallOptions = {},
): Promise<PdfProbe> {
  const r = await client.probe(`/books/${encodeURIComponent(bookUid)}/pdf-${kind}`, opts);
  if (r.status === 200) return { state: 'present', probe: r };
  if (r.status === 404 && r.errorCode === 'ERR_PDF_NOT_UPLOADED')
    return { state: 'absent', probe: r };
  throw new BookPrintApiError({
    status: r.status,
    message: r.message ?? `HTTP ${r.status}`,
    errorCode: r.errorCode,
    errors: r.errors,
    fieldErrors: r.fieldErrors,
    data: r.data,
    raw: r.raw,
    headers: r.headers,
    request: r.request,
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
