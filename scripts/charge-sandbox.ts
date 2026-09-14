/**
 * sandbox 충전금을 채우고 잔액을 보여 준다. live 잔액은 채울 수 없다(포털 > 충전금 > 충전).
 * 사용: node --env-file=.env --import tsx scripts/charge-sandbox.ts [금액] [--memo <메모>]
 *       금액을 빼면 잔액만 보여 준다.
 */
import { parseArgs } from 'node:util';
import { BookPrintClient, getCredits, sandboxChargeCredits } from '../src/bookprint/index.js';
import { loadConfig } from '../src/config/env.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { memo: { type: 'string' } },
});

const config = loadConfig('sandbox');
const client = new BookPrintClient({ apiKey: config.apiKey, environment: config.environment });
const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')} KRW`;

const [amountArg] = positionals;
if (amountArg === undefined) {
  const { data } = await getCredits(client);
  console.log(`잔액 ${won(data.balance)}  (sandbox · 서버 표기 "${data.env}")`);
  process.exit(0);
}

const amount = Number(amountArg);
if (!Number.isFinite(amount) || amount <= 0) {
  console.error(`금액은 0보다 큰 수여야 합니다: ${amountArg}`);
  process.exit(1);
}

const before = (await getCredits(client)).data.balance;
const { data } = await sandboxChargeCredits(client, {
  amount,
  ...(values.memo ? { memo: values.memo } : {}),
});
console.log(`충전 ${won(amount)} — 잔액 ${won(before)} → ${won(data.balance)}`);
