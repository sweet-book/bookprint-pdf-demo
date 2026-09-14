import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookPrintApiError } from '../../src/bookprint/index.js';
import { printError, printLogEntry, safeForTerminal } from '../../src/cli/render.js';
import { type LogEntry, newJob, toJobError } from '../../src/flow/index.js';

const ESC = '\u001B';
/** 앞 두 줄을 지우고 제 문장을 앉히는 열 */
const OVERWRITE = `${ESC}[2K${ESC}[1A${ESC}[2K주문이 취소되었습니다`;

function captured(fn: () => void): string {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  const grab = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  console.log = grab;
  console.error = grab;
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join('\n');
}

test('제어문자는 눈에 보이는 escape 로 바뀌고, 줄바꿈·탭과 한글은 그대로다', () => {
  assert.equal(safeForTerminal(OVERWRITE), '\\x1B[2K\\x1B[1A\\x1B[2K주문이 취소되었습니다');
  assert.equal(safeForTerminal('한 줄\n다음 줄\t칸'), '한 줄\n다음 줄\t칸', '우리 서식은 살린다');
  assert.equal(safeForTerminal('덮어쓰기\r'), '덮어쓰기\\x0D', 'CR 하나로도 줄을 다시 쓴다');
  assert.equal(safeForTerminal('\u007F\u009B[2K'), '\\x7F\\x9B[2K', 'DEL 과 C1 CSI 도 막는다');
  // 제어문자가 없는 문자열은 한 글자도 달라지지 않는다
  const plain = '표지 PDF 규격이 맞지 않습니다 (544×288mm 이어야 합니다) — errors[0]';
  assert.equal(safeForTerminal(plain), plain);
});

test('서버 오류 본문의 제어열이 터미널까지 그대로 나가지 않는다', () => {
  const now = () => new Date('2026-09-10T03:00:00Z');
  let seq = 0;
  const job = newJob(
    { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
    { env: 'sandbox', now, uuid: () => `u-${++seq}` },
  );
  const request = {
    method: 'POST',
    url: 'https://api-sandbox.sweetbook.com/v1/orders',
    headers: {},
    bodySummary: null,
  };
  const err = new BookPrintApiError({
    status: 400,
    message: `주문 실패${OVERWRITE}`,
    errorCode: 'ERR_VALIDATION',
    errors: [OVERWRITE],
    fieldErrors: [{ field: `items${ESC}[2K`, message: OVERWRITE, constraint: 'required' }],
    data: null,
    raw: '{}',
    headers: {},
    request,
  });
  const entry: LogEntry = {
    step: 'createOrder',
    at: now().toISOString(),
    attempt: 1,
    ms: 120,
    request,
    response: null,
    error: toJobError(err),
    replayed: false,
  };

  const out = captured(() => {
    printLogEntry(job, entry, 0, false);
  });
  assert.ok(!out.includes(ESC), `기록 출력에 ESC 가 남았다: ${JSON.stringify(out)}`);
  assert.ok(out.includes('주문이 취소되었습니다'), '서버가 한 말 자체는 지우지 않는다');

  const direct = captured(() => {
    printError(OVERWRITE, OVERWRITE);
  });
  assert.ok(!direct.includes(ESC), '흐름 밖 오류 출력도 같은 문을 지난다');
});
