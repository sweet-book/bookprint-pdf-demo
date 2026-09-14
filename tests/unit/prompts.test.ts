import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Prompter } from '../../src/cli/prompts.js';

function piped(lines: string[]): PassThrough {
  const s = new PassThrough();
  s.end(`${lines.join('\n')}\n`);
  return s;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('줄을 순서대로 읽고 빈 줄은 기본값', async () => {
  const p = new Prompter(undefined, piped(['a', '', 'c']));
  assert.equal(await p.ask('1', 'd1'), 'a');
  assert.equal(await p.ask('2', 'd2'), 'd2');
  assert.equal(await p.ask('3', 'd3'), 'c');
  p.close();
});

test('프롬프트 사이에 긴 작업이 끼어 입력이 먼저 닫혀도 남은 줄을 잃지 않는다', async () => {
  const p = new Prompter(undefined, piped(['', '', '', '', '', '', 'n']));
  for (let i = 0; i < 6; i++) await p.ask(`q${i}`, 'd');
  await tick(50); // 이 사이에 입력 스트림이 끝난다
  assert.equal(await p.confirm('go?'), false, "'n' 이 버퍼에 남아 있어야 한다");
  assert.equal(await p.ask('after-eof', 'fallback'), 'fallback', '그 뒤는 EOF 라 기본값');
  p.close();
});

test('입력이 끝나면 confirm 은 아니오 — 무인 실행에서 주문이 나가지 않는다', async () => {
  const p = new Prompter(undefined, piped([]));
  assert.equal(await p.confirm('order?'), false);
  p.close();
});

test('y 만 예로 본다. 대소문자 무시', async () => {
  const p = new Prompter(undefined, piped(['Y', 'yes', 'y']));
  assert.equal(await p.confirm('1'), true);
  assert.equal(await p.confirm('2'), false, '"yes" 는 y 가 아니다 — 정확히 한 글자만');
  assert.equal(await p.confirm('3'), true);
  p.close();
});

test('줄이 아직 안 왔으면 기다렸다가 받는다', async () => {
  const s = new PassThrough();
  const p = new Prompter(undefined, s);
  const pending = p.ask('late', 'd');
  await tick(30);
  s.write('late-answer\n');
  assert.equal(await pending, 'late-answer');
  s.end();
  p.close();
});
