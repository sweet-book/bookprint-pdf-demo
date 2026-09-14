import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBookStatus } from '../../src/bookprint/index.js';
import { ConfigError, loadConfig, maskKey, parseEnvironment } from '../../src/config/env.js';
import { maskSecrets } from '../../src/flow/index.js';
import { TEST_KEY } from '../helpers.js';

test('환경별 변수 이름 — sandbox 키로 live 를 고르면 기동 실패', () => {
  const env = { SWEETBOOK_SANDBOX_API_KEY: TEST_KEY };
  assert.equal(loadConfig('sandbox', env).apiKey, TEST_KEY);
  assert.throws(() => loadConfig('live', env), ConfigError);
});

test('키 형식 검증 — 공백·줄바꿈·잘린 키를 잡는다', () => {
  assert.equal(
    loadConfig('sandbox', { SWEETBOOK_SANDBOX_API_KEY: ` ${TEST_KEY}\n` }).apiKey,
    TEST_KEY,
  );
  assert.throws(() => loadConfig('sandbox', { SWEETBOOK_SANDBOX_API_KEY: 'SBshort.key' }), /형식/);
  assert.throws(() => loadConfig('sandbox', {}), /비어/);
});

test('마스킹 — 앞 12자만. 오류 메시지에도 전체 키가 없다', () => {
  assert.equal(maskKey(TEST_KEY), 'SBTESTKEY000.****');
  assert.equal(
    loadConfig('sandbox', { SWEETBOOK_SANDBOX_API_KEY: TEST_KEY }).apiKeyMasked,
    'SBTESTKEY000.****',
  );
  try {
    loadConfig('sandbox', { SWEETBOOK_SANDBOX_API_KEY: `${TEST_KEY}X` });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(!e.message.includes(TEST_KEY));
  }
  assert.equal(maskSecrets(`Bearer ${TEST_KEY} end`), 'Bearer SBTESTKEY000.**** end');
});

test('parseEnvironment', () => {
  assert.equal(parseEnvironment(undefined), 'sandbox');
  assert.equal(parseEnvironment('live'), 'live');
  assert.throws(() => parseEnvironment('prod'), ConfigError);
});

test('normalizeBookStatus — 정수·문자열 세 표기를 하나로', () => {
  assert.equal(normalizeBookStatus(1), 'DRAFT');
  assert.equal(normalizeBookStatus('draft'), 'DRAFT');
  assert.equal(normalizeBookStatus(2), 'FINALIZED');
  assert.equal(normalizeBookStatus('finalized'), 'FINALIZED');
  assert.equal(normalizeBookStatus(9), 'DELETED');
  assert.equal(normalizeBookStatus(null), 'UNKNOWN');
});
