import type { ApiResult, BookPrintClient, CallOptions } from '../client.js';
import type { BookSpec, CalculatedSize } from '../types.js';

/** GET /book-specs — 판형 목록. 계정에 열린 판형만 온다 */
export function listBookSpecs(
  client: BookPrintClient,
  opts: CallOptions = {},
): Promise<ApiResult<BookSpec[]>> {
  return client.get<BookSpec[]>('/book-specs', undefined, opts);
}

/** GET /book-specs/{uid}/calculated-size?pages=N — 표지·내지 규격(mm). pages 는 짝수 */
export function getCalculatedSize(
  client: BookPrintClient,
  bookSpecUid: string,
  pages: number,
  opts: CallOptions = {},
): Promise<ApiResult<CalculatedSize>> {
  return client.get<CalculatedSize>(
    `/book-specs/${encodeURIComponent(bookSpecUid)}/calculated-size`,
    { pages },
    opts,
  );
}
