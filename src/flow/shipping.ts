import { FlowRuleError } from './errors.js';
import type { Shipping } from './job.js';

const REQUIRED = ['recipientName', 'recipientPhone', 'postalCode', 'address1'] as const;
const OPTIONAL = ['address2', 'memo'] as const;
const KNOWN: readonly string[] = [...REQUIRED, ...OPTIONAL];

const MAX_LENGTH: Readonly<Record<string, number>> = {
  recipientName: 100,
  recipientPhone: 20,
  postalCode: 10,
  address1: 200,
  address2: 200,
  memo: 200,
};

export interface ShippingWarning {
  field: string;
  message: string;
}

export interface ParsedShipping {
  shipping: Shipping;
  /** 서버는 통과시키지만 사람이 확인해야 하는 것 */
  warnings: ShippingWarning[];
}

/**
 * 배송지 JSON 을 검사한다. 항목 이름 오타·필수 누락·길이 초과는 FlowRuleError,
 * 서버가 검사하지 않는 형식 문제와 모르는 항목은 warnings 로 돌려준다.
 */
export function parseShipping(value: unknown, source = '배송지'): ParsedShipping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FlowRuleError(`${source}: 객체(JSON object)여야 합니다`);
  }
  const rec = value as Record<string, unknown>;

  const typos: string[] = [];
  const unknown: string[] = [];
  for (const key of Object.keys(rec)) {
    if (KNOWN.includes(key)) continue;
    const sameName = KNOWN.find((k) => normalizeKey(k) === normalizeKey(key));
    if (sameName) typos.push(`${key} → ${sameName}`);
    else unknown.push(key);
  }
  if (typos.length > 0) {
    throw new FlowRuleError(`${source}: 항목 이름이 틀렸습니다 — ${typos.join(', ')}`, {
      errorCode: 'ERR_SHIPPING_FIELD_TYPO',
      data: { typos },
    });
  }

  const missing = REQUIRED.filter((k) => typeof rec[k] !== 'string' || rec[k].trim() === '');
  if (missing.length > 0) {
    throw new FlowRuleError(`${source}: 필수 항목이 비어 있습니다 — ${missing.join(', ')}`, {
      errorCode: 'ERR_SHIPPING_INCOMPLETE',
      data: { missing },
    });
  }

  const out: Shipping = {
    recipientName: (rec.recipientName as string).trim(),
    recipientPhone: (rec.recipientPhone as string).trim(),
    postalCode: (rec.postalCode as string).trim(),
    address1: (rec.address1 as string).trim(),
  };
  for (const k of OPTIONAL) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  }

  const tooLong = Object.entries(out)
    .filter(
      ([k, v]) => typeof v === 'string' && v.length > (MAX_LENGTH[k] ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([k, v]) => `${k} ${(v as string).length}자 (최대 ${MAX_LENGTH[k]}자)`);
  if (tooLong.length > 0) {
    throw new FlowRuleError(`${source}: 너무 깁니다 — ${tooLong.join(', ')}`, {
      errorCode: 'ERR_SHIPPING_TOO_LONG',
      data: { tooLong },
    });
  }

  const warnings = shippingWarnings(out);
  for (const key of unknown) {
    const near = nearestKnown(key);
    warnings.push({
      field: key,
      message: near
        ? `모르는 항목입니다. ${near} 를 쓰려던 것이 아닌가요? 서버는 이 값을 버립니다`
        : '모르는 항목입니다. 서버는 이 값을 버립니다',
    });
  }
  return { shipping: out, warnings };
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 서버가 검사하지 않는 형식(우편번호·전화번호·주소 길이)에 대한 경고. 국내 형식을 가정한다 */
export function shippingWarnings(s: Shipping): ShippingWarning[] {
  const w: ShippingWarning[] = [];
  if (!/^\d{5}$/.test(s.postalCode)) {
    w.push({
      field: 'postalCode',
      message: `"${s.postalCode}" — 국내 우편번호는 5자리 숫자입니다. 서버는 형식을 검사하지 않습니다`,
    });
  }
  const digits = s.recipientPhone.replace(/\D/g, '').length;
  if (digits < 8) {
    w.push({
      field: 'recipientPhone',
      message: `"${s.recipientPhone}" — 숫자가 ${digits}개뿐입니다. 전화번호가 맞습니까?`,
    });
  }
  if (s.address1.length < 5) {
    w.push({ field: 'address1', message: `"${s.address1}" — 주소가 너무 짧습니다` });
  }
  return w;
}

/** 편집 거리 2 이내의 알려진 항목 이름. 없으면 null */
function nearestKnown(key: string): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  let bestDistance = 3;
  for (const k of KNOWN) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = k;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
