import type { ApiResult, BookPrintClient, CallOptions } from '../client.js';
import type { CreditAccount, SandboxChargeRequest } from '../types.js';

/** GET /credits — 충전금 잔액 */
export function getCredits(
  client: BookPrintClient,
  opts: CallOptions = {},
): Promise<ApiResult<CreditAccount>> {
  return client.get<CreditAccount>('/credits', undefined, opts);
}

/**
 * POST /credits/sandbox/charge — 가상 충전금 충전. 키 환경과 무관하게 test 잔액에 들어간다.
 * 재시도하지 않는다.
 */
export function sandboxChargeCredits(
  client: BookPrintClient,
  req: SandboxChargeRequest,
  opts: CallOptions = {},
): Promise<ApiResult<CreditAccount>> {
  return client.request<CreditAccount>({
    method: 'POST',
    path: '/credits/sandbox/charge',
    json: req,
    ...opts,
  });
}
