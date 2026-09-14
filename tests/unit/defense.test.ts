import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlowRuleError, parseShipping, shippingWarnings } from '../../src/flow/index.js';

const OK = {
  recipientName: '홍길동',
  recipientPhone: '010-0000-0000',
  postalCode: '06134',
  address1: '서울특별시 강남구 테헤란로 100',
};

// ---------------------------------------------------------------- 막는다: 배송지

test('필수 항목이 비면 거부 — 어느 항목인지 이름으로 알려준다', () => {
  assert.throws(
    () => parseShipping({ recipientName: '홍' }),
    (e: unknown) => {
      assert.ok(e instanceof FlowRuleError);
      assert.equal(e.errorCode, 'ERR_SHIPPING_INCOMPLETE');
      assert.match(e.message, /recipientPhone, postalCode, address1/);
      return true;
    },
  );
});

test('확실한 오타만 막는다 — 대소문자·구분자만 다른 것', () => {
  for (const [typo, expected] of [
    ['recipientname', 'recipientName'],
    ['RECIPIENTNAME', 'recipientName'],
    ['postal_code', 'postalCode'],
    ['address-1', 'address1'],
  ] as const) {
    assert.throws(
      () => parseShipping({ ...OK, [typo]: 'x' }),
      (e: unknown) => {
        assert.ok(e instanceof FlowRuleError);
        assert.equal(e.errorCode, 'ERR_SHIPPING_FIELD_TYPO');
        assert.match(e.message, new RegExp(`${typo} → ${expected}`));
        return true;
      },
    );
  }
});

test('이름이 실제로 다른 키는 막지 않고 묻는다 — 파트너가 일부러 넣었을 수 있다', () => {
  // 비슷하면 짚어는 준다
  const near = parseShipping({ ...OK, adress1: '오타일까 아닐까' });
  assert.equal(near.warnings.length, 1);
  assert.match(near.warnings[0]?.message ?? '', /address1/);
  // 아주 다른 이름도 알려 준다
  const far = parseShipping({ ...OK, country: 'KR' });
  assert.equal(far.warnings.length, 1);
  assert.match(far.warnings[0]?.message ?? '', /서버는 이 값을 버립니다/);
});

test('길이 상한은 문서 값 — 수취인 100 · 전화 20 · 우편번호 10 · 주소 200 · 상세주소 200 · 메모 200', () => {
  const over = (field: string, n: number) => ({ ...OK, [field]: 'x'.repeat(n) });
  for (const [field, limit] of [
    ['recipientName', 100],
    ['recipientPhone', 20],
    ['postalCode', 10],
    ['address1', 200],
    ['address2', 200],
    ['memo', 200],
  ] as const) {
    assert.throws(
      () => parseShipping(over(field, limit + 1)),
      (e: unknown) => {
        assert.ok(e instanceof FlowRuleError);
        assert.equal(e.errorCode, 'ERR_SHIPPING_TOO_LONG');
        assert.match(e.message, new RegExp(`${field} ${limit + 1}자`));
        return true;
      },
    );
    // 상한 자체는 통과해야 한다
    assert.doesNotThrow(() => parseShipping(over(field, limit)));
  }
});

test('선택 항목은 있을 때만, 공백은 다듬는다', () => {
  const { shipping } = parseShipping({ ...OK, address2: ' 1층 ', memo: '' });
  assert.deepEqual(shipping, { ...OK, address2: '1층' });
});

// ---------------------------------------------------------------- 묻는다: 형식

test('우편번호가 5자리 숫자가 아니면 경고 — 거부하지 않는다. 서버도 통과시킨다', () => {
  const { shipping, warnings } = parseShipping({ ...OK, postalCode: '1' });
  assert.equal(shipping.postalCode, '1', '값은 그대로 살아 있다');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.field, 'postalCode');
});

test('전화번호 숫자가 8개 미만이면 경고 — 국가번호를 붙인 긴 번호는 경고하지 않는다', () => {
  assert.equal(shippingWarnings({ ...OK, recipientPhone: 'not-a-phone' }).length, 1);
  assert.equal(shippingWarnings({ ...OK, recipientPhone: '02-123-4567' }).length, 0, '9자리 유선');
  assert.equal(shippingWarnings({ ...OK, recipientPhone: '010-1234-5678' }).length, 0);
});

test('정상 배송지는 경고가 없다', () => {
  assert.deepEqual(parseShipping(OK).warnings, []);
});
