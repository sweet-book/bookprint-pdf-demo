import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';

/** 대화형 입력. 입력이 끝났거나 close() 된 뒤의 물음은 기본값·"아니오" 로 끝난다 */
export class Prompter {
  private rl: Interface | null = null;
  private readonly lines: string[] = [];
  private ended = false;
  private closed = false;
  private waiter: (() => void) | null = null;

  /**
   * @param onInterrupt Ctrl+C 처리기
   * @param input 기본 process.stdin
   */
  constructor(
    private readonly onInterrupt?: () => void,
    private readonly input: Readable = process.stdin,
  ) {}

  private open(): void {
    if (this.rl || this.closed) return;
    // terminal:false — raw 모드에서는 Windows 한글 IME 가 한/영 전환 뒤 영문 키를 삼킨다
    this.rl = createInterface({ input: this.input, terminal: false });
    if (this.onInterrupt) this.rl.on('SIGINT', this.onInterrupt);
    this.rl.on('line', (line) => {
      this.lines.push(line);
      this.wake();
    });
    this.rl.on('close', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private async readLine(): Promise<string | null> {
    this.open();
    while (this.lines.length === 0) {
      if (this.ended || this.closed) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.lines.shift() ?? null;
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    process.stdout.write(`${question}${suffix}: `);
    const line = await this.readLine();
    if (line === null) {
      process.stdout.write(`${defaultValue ?? ''}\n`);
      return defaultValue ?? '';
    }
    const answer = line.trim();
    return answer === '' && defaultValue !== undefined ? defaultValue : answer;
  }

  /** 기본값은 "아니오" — 입력이 끝났거나 빈 줄이면 false */
  async confirm(question: string, expected = 'y'): Promise<boolean> {
    process.stdout.write(`${question} (${expected}/N): `);
    const line = await this.readLine();
    if (line === null) {
      process.stdout.write('N\n');
      return false;
    }
    return line.trim().toLowerCase() === expected;
  }

  /** 대기 중인 물음을 기본값·"아니오" 로 끝내고, 이후 물음도 기다리지 않게 한다 */
  close(): void {
    this.closed = true;
    this.rl?.close();
    this.rl = null;
    this.lines.length = 0;
    this.wake();
  }
}
