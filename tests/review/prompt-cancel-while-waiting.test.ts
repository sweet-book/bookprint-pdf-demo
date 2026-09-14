import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Prompter } from '../../src/cli/prompts.js';

/** 시간 안에 풀리지 않으면 'PENDING' */
function settle<T>(p: Promise<T>, ms = 500): Promise<T | 'PENDING'> {
  return Promise.race([p, new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms))]);
}

test('confirm 을 기다리는 중 close() 하면 "아니오" 로 풀린다', async () => {
  const prompter = new Prompter(undefined, new PassThrough());
  const answer = prompter.confirm('주문할까요?');
  await new Promise((r) => setTimeout(r, 20)); // 읽기가 대기에 들어간 뒤
  prompter.close();
  assert.equal(await settle(answer), false);
});

test('ask 를 기다리는 중 close() 하면 기본값으로 풀린다', async () => {
  const prompter = new Prompter(undefined, new PassThrough());
  const answer = prompter.ask('판형 UID', 'SQUAREBOOK_HC');
  await new Promise((r) => setTimeout(r, 20));
  prompter.close();
  assert.equal(await settle(answer), 'SQUAREBOOK_HC');
});

test('close() 뒤의 물음은 입력을 다시 열지 않고 곧바로 기본값·아니오로 끝난다', async () => {
  const prompter = new Prompter(undefined, new PassThrough());
  prompter.close();
  assert.equal(await settle(prompter.ask('수량', '1')), '1');
  assert.equal(await settle(prompter.confirm('주문할까요?')), false);
});
