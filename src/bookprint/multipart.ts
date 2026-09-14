import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export interface MultipartFilePart {
  /** form 필드 이름. BookPrint 업로드는 'file' */
  fieldName: string;
  filename: string;
  contentType: string;
  /** 파일 바이트 수 */
  size: number;
  /** 부를 때마다 새 스트림을 연다 */
  open: () => AsyncIterable<Uint8Array>;
}

export interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number;
  boundary: string;
}

/** 파일 하나짜리 multipart/form-data 본문을 스트림으로 조립한다 */
export function buildFileMultipart(
  part: MultipartFilePart,
  options: { boundary?: string } = {},
): MultipartBody {
  const boundary = options.boundary ?? `----bookprint-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${quote(part.fieldName)}"; filename="${quote(part.filename)}"\r\n` +
      `Content-Type: ${part.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield head;
    for await (const c of part.open()) yield c;
    yield tail;
  }

  const body = Readable.toWeb(Readable.from(chunks())) as unknown as ReadableStream<Uint8Array>;
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.byteLength + part.size + tail.byteLength,
    boundary,
  };
}

/** 헤더 값 안의 따옴표·줄바꿈을 무력화한다 */
function quote(s: string): string {
  return s.replace(/["\r\n]/g, '_');
}
