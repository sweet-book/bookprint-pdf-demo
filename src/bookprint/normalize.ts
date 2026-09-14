import type { BookStatus } from './types.js';

/** 책 상태 표기(단건·업로드의 정수 1/2, 목록의 "draft"/"finalized"/"deleted")를 하나로 */
export function normalizeBookStatus(value: unknown): BookStatus {
  if (value === 1 || value === '1' || value === 'draft') return 'DRAFT';
  if (value === 2 || value === '2' || value === 'finalized') return 'FINALIZED';
  if (value === 9 || value === '9' || value === 'deleted') return 'DELETED';
  return 'UNKNOWN';
}
