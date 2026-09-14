/**
 * 시험으로 만든 책을 지운다.
 * 사용: node --env-file=.env --import tsx scripts/delete-book.ts <bookUid> [--env sandbox|live]
 *       live 는 --i-know-this-is-live 를 함께 주어야 한다.
 */
import { parseArgs } from 'node:util';
import { BookPrintClient, deleteBook } from '../src/bookprint/index.js';
import { loadConfig, parseEnvironment } from '../src/config/env.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    'i-know-this-is-live': { type: 'boolean', default: false },
  },
});
const [bookUid] = positionals;
if (!bookUid) {
  console.error('사용: delete-book.ts <bookUid> [--env sandbox|live] [--i-know-this-is-live]');
  process.exit(1);
}
const environment = parseEnvironment(values.env);
if (environment === 'live' && !values['i-know-this-is-live']) {
  console.error('live 책 삭제는 --i-know-this-is-live 를 함께 주어야 합니다 (되돌릴 수 없습니다)');
  process.exit(1);
}
const config = loadConfig(environment);
const client = new BookPrintClient({ apiKey: config.apiKey, environment: config.environment });
const res = await deleteBook(client, bookUid);
console.log(`${res.status} ${res.data.bookUid} → ${res.data.status}`);
