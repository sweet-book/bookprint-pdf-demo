import type { ApiResult, BookPrintClient, CallOptions } from '../client.js';
import type { CreateOrderRequest, EstimateRequest, EstimateResponse, Order } from '../types.js';

/** POST /orders/estimate — 견적. 부작용 없음 */
export function estimateOrder(
  client: BookPrintClient,
  req: EstimateRequest,
  opts: CallOptions = {},
): Promise<ApiResult<EstimateResponse>> {
  return client.request<EstimateResponse>({
    method: 'POST',
    path: '/orders/estimate',
    json: req,
    retry: true,
    ...opts,
  });
}

/** POST /orders — 주문. 충전금이 바로 차감된다 */
export function createOrder(
  client: BookPrintClient,
  req: CreateOrderRequest,
  idempotencyKey: string,
  opts: CallOptions = {},
): Promise<ApiResult<Order>> {
  return client.request<Order>({
    method: 'POST',
    path: '/orders',
    json: req,
    idempotencyKey,
    ...opts,
  });
}

/** POST /orders/{uid}/cancel — 주문 취소·전액 환불. PAID·PDF_READY 상태에서만 된다 */
export function cancelOrder(
  client: BookPrintClient,
  orderUid: string,
  cancelReason: string,
  idempotencyKey: string,
  opts: CallOptions = {},
): Promise<ApiResult<Order>> {
  return client.request<Order>({
    method: 'POST',
    path: `/orders/${encodeURIComponent(orderUid)}/cancel`,
    json: { cancelReason },
    idempotencyKey,
    ...opts,
  });
}
