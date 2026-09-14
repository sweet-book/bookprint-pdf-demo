/** 서버가 아니라 이 앱이 거부한 것 (잠금, 입력 누락, 견적 단계의 잔액 부족) */
export class FlowRuleError extends Error {
  override readonly name = 'FlowRuleError';
  readonly errorCode: string | null;
  readonly data: unknown;
  constructor(message: string, extra: { errorCode?: string; data?: unknown } = {}) {
    super(message);
    this.errorCode = extra.errorCode ?? null;
    this.data = extra.data ?? null;
  }
}
