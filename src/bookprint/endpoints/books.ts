import type { ApiResult, BookPrintClient, CallOptions } from '../client.js';
import type {
  BookDetail,
  CreateBookRequest,
  CreateBookResponse,
  FinalizeResponse,
} from '../types.js';

/** POST /books — 책 생성 */
export function createBook(
  client: BookPrintClient,
  req: CreateBookRequest,
  idempotencyKey: string,
  opts: CallOptions = {},
): Promise<ApiResult<CreateBookResponse>> {
  return client.request<CreateBookResponse>({
    method: 'POST',
    path: '/books',
    json: req,
    idempotencyKey,
    ...opts,
  });
}

/** GET /books/{uid} — 책 단건 조회 */
export function getBook(
  client: BookPrintClient,
  bookUid: string,
  opts: CallOptions = {},
): Promise<ApiResult<BookDetail>> {
  return client.get<BookDetail>(`/books/${encodeURIComponent(bookUid)}`, undefined, opts);
}

/** DELETE /books/{uid} — 책 삭제(소프트 삭제) */
export function deleteBook(
  client: BookPrintClient,
  bookUid: string,
  opts: CallOptions = {},
): Promise<ApiResult<{ bookUid: string; status: string }>> {
  return client.request({
    method: 'DELETE',
    path: `/books/${encodeURIComponent(bookUid)}`,
    ...opts,
  });
}

/** POST /books/{uid}/finalization — 최종화 */
export function finalizeBook(
  client: BookPrintClient,
  bookUid: string,
  idempotencyKey: string,
  opts: CallOptions = {},
): Promise<ApiResult<FinalizeResponse>> {
  return client.request<FinalizeResponse>({
    method: 'POST',
    path: `/books/${encodeURIComponent(bookUid)}/finalization`,
    idempotencyKey,
    ...opts,
  });
}
