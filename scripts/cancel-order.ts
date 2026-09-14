/**
 * Sandbox 테스트가 만든 주문을 취소해 충전금을 돌려받는다.
 * 사용: node --env-file=.env --import tsx scripts/cancel-order.ts <orderUid> [--env sandbox|live] [--reason <text>]
 *       live 는 --i-know-this-is-live 를 함께 주어야 한다.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { BookPrintClient, cancelOrder } from '../src/bookprint/index.js';
import { loadConfig, parseEnvironment } from '../src/config/env.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    reason: { type: 'string' },
    'i-know-this-is-live': { type: 'boolean', default: false },
  },
});
const [orderUid] = positionals;
if (!orderUid) {
  console.error(
    '사용: cancel-order.ts <orderUid> [--env sandbox|live] [--reason <text>] [--i-know-this-is-live]',
  );
  process.exit(1);
}
const environment = parseEnvironment(values.env);
if (environment === 'live' && !values['i-know-this-is-live']) {
  console.error(
    'live 주문 취소는 --i-know-this-is-live 를 함께 주어야 합니다 (실제 주문이 취소·환불됩니다)',
  );
  process.exit(1);
}
const config = loadConfig(environment);
const client = new BookPrintClient({ apiKey: config.apiKey, environment: config.environment });
const res = await cancelOrder(
  client,
  orderUid,
  values.reason ?? 'bookprint-pdf-demo sandbox test cleanup',
  randomUUID(),
);
console.log(
  `${res.status} ${res.data.orderUid} → ${res.data.orderStatus}  환불 ${res.data.refundAmount ?? '-'}`,
);
