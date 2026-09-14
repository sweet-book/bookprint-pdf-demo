import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PdfUploadFile } from '../bookprint/index.js';

export const PDF_MAX_BYTES = 500 * 1024 * 1024;
const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');

export type PdfPrecheckReason = 'not-found' | 'not-a-file' | 'too-large' | 'not-pdf';

export class PdfPrecheckError extends Error {
  override readonly name = 'PdfPrecheckError';
  constructor(
    readonly reason: PdfPrecheckReason,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LocalPdfFile extends PdfUploadFile {
  path: string;
}

/** PDF 사전 검사 — 파일이 있는지, 500MB 이하인지, %PDF- 로 시작하는지만 본다 */
export async function openPdf(path: string): Promise<LocalPdfFile> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new PdfPrecheckError('not-a-file', path, `파일이 아닙니다: ${path}`);
    size = st.size;
  } catch (err) {
    if (err instanceof PdfPrecheckError) throw err;
    throw new PdfPrecheckError('not-found', path, `파일을 찾을 수 없습니다: ${path}`);
  }
  if (size > PDF_MAX_BYTES) {
    throw new PdfPrecheckError(
      'too-large',
      path,
      `${(size / 1024 / 1024).toFixed(1)}MB — 500MB 를 넘습니다: ${path}`,
    );
  }
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(PDF_SIGNATURE.length);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (bytesRead < PDF_SIGNATURE.length || !head.equals(PDF_SIGNATURE)) {
      throw new PdfPrecheckError('not-pdf', path, `PDF 가 아닙니다 (시그니처 %PDF- 없음): ${path}`);
    }
  } finally {
    await fh.close();
  }
  return {
    path,
    filename: basename(path),
    size,
    open: () => createReadStream(path),
  };
}
