import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ESTIMATE_TTL_MS,
  type JobState,
  newJob,
  STEP_ORDER,
  type StepName,
} from '../../src/flow/index.js';
import { FileJobStore } from '../../src/store/fileStore.js';
import { fixture, TEST_KEY } from '../helpers.js';

interface Route {
  status: number;
  body: string;
}

/** 모의 API — "메서드 경로" 로 응답을 고르고, 받은 요청을 순서대로 남긴다. 없는 경로는 404 */
async function mockApi(routes: Record<string, Route>) {
  const served: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]?.replace(/^\/v1/, '') ?? '';
    const route = `${req.method} ${path}`;
    served.push(route);
    req.resume();
    req.on('end', () => {
      const r = routes[route] ?? {
        status: 404,
        body: JSON.stringify({
          success: false,
          message: `모의 서버에 없는 경로: ${route}`,
          data: null,
          errorCode: 'ERR_NOT_FOUND',
          errors: [],
          fieldErrors: [],
        }),
      };
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    served,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function runCli(
  args: string[],
  opts: {
    env: Record<string, string>;
    stdin?: string;
    preload?: string;
    /** 입력을 닫지 않는다 — 프롬프트가 "입력 끝" 으로 곧바로 끝나지 않고 기다리게 */
    keepStdinOpen?: boolean;
  },
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const node = [
      ...(opts.preload ? ['--import', opts.preload] : []),
      '--import',
      'tsx',
      'src/cli/main.ts',
      ...args,
    ];
    const child = spawn(process.execPath, node, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    // 시간 안에 끝나지 않으면 죽이고 code 는 null
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on('error', () => {});
    if (opts.keepStdinOpen) child.stdin.write(opts.stdin ?? '');
    else child.stdin.end(opts.stdin ?? '');
  });
}

function sandboxEnv(jobsDir: string, baseUrl: string): Record<string, string> {
  return {
    SWEETBOOK_SANDBOX_API_KEY: TEST_KEY,
    BOOKPRINT_BASE_URL_OVERRIDE: baseUrl,
    BOOKPRINT_JOBS_DIR: jobsDir,
  };
}

const INPUT = {
  bookSpecUid: 'SQUAREBOOK_HC',
  pageCount: 24,
  title: 't',
  coverPath: 'fixtures/SQUAREBOOK_HC_cover_24p.pdf',
  contentsPath: 'fixtures/SQUAREBOOK_HC_inner_24p.pdf',
  quantity: 1,
  shipping: {
    recipientName: '홍길동',
    recipientPhone: '010-0000-0000',
    postalCode: '06134',
    address1: '서울특별시 강남구 테헤란로 100',
  },
};

/** `lastDone` 단계까지 끝난 작업을 작업 파일로 둔다 */
async function seedJob(jobsDir: string, lastDone: StepName): Promise<JobState> {
  let seq = 0;
  const job = newJob(INPUT, {
    env: 'sandbox',
    now: () => new Date(),
    uuid: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  });
  for (const step of STEP_ORDER) {
    job.steps[step] = { ...job.steps[step], status: 'DONE', finishedAt: new Date().toISOString() };
    if (step === lastDone) break;
  }
  job.bookUid = 'bk_7H7BF7a6g3rU';
  await new FileJobStore(jobsDir).save(job);
  return job;
}

const count = (text: string, part: string): number => text.split(part).length - 1;

/** 화면에 `prompt` 가 찍히면 Ctrl+C 처리기를 부르는 preload. Windows 는 자식 프로세스에 SIGINT 를 보낼 수 없다 */
async function sigintWhen(dir: string, prompt: string): Promise<string> {
  const file = join(dir, 'sigint.mjs');
  await writeFile(
    file,
    `const write = process.stdout.write.bind(process.stdout);
let sent = false;
process.stdout.write = (chunk, ...rest) => {
  if (!sent && String(chunk).includes(${JSON.stringify(prompt)})) {
    sent = true;
    setTimeout(() => process.emit('SIGINT'), 100);
  }
  return write(chunk, ...rest);
};
`,
  );
  return pathToFileURL(file).href;
}

test('live 무인 실행은 --i-know-this-is-live 없이 막힌다', async () => {
  const jobsDir = await mkdtemp(join(tmpdir(), 'bookprint-cli-'));
  // 없는 작업 — 관문이 뚫려도 live 서버에 닿기 전에 끝난다
  const env = { SWEETBOOK_LIVE_API_KEY: TEST_KEY, BOOKPRINT_JOBS_DIR: jobsDir };
  const passedGate = /작업을 찾을 수 없습니다/;
  try {
    const yesOnly = await runCli(['resume', 'j_none', '--env', 'live', '--yes'], { env });
    assert.equal(yesOnly.code, 1);
    assert.match(yesOnly.out, /--yes 와 --i-know-this-is-live 를 함께/);
    assert.doesNotMatch(yesOnly.out, passedGate, '--yes 만으로는 관문을 지나지 못한다');

    const typedY = await runCli(['resume', 'j_none', '--env', 'live'], { env, stdin: 'y\n' });
    assert.equal(typedY.code, 1);
    assert.doesNotMatch(typedY.out, passedGate, '대화식에서는 yes 를 온전히 입력해야 한다');

    const both = await runCli(
      ['resume', 'j_none', '--env', 'live', '--yes', '--i-know-this-is-live'],
      { env },
    );
    assert.match(both.out, passedGate, '둘 다 주면 관문을 지나 다음 검사에 닿는다');
  } finally {
    await rm(jobsDir, { recursive: true, force: true });
  }
});

test('같은 입력으로 run 을 다시 치면 끝나지 않은 작업을 알려 주고, 거절하면 책을 만들지 않는다', async () => {
  const jobsDir = await mkdtemp(join(tmpdir(), 'bookprint-cli-'));
  const api = await mockApi({
    'GET /book-specs': { status: 200, body: fixture('bookspecs_list.json').raw },
  });
  try {
    const existing = await seedJob(jobsDir, 'createBook');
    const res = await runCli(
      [
        'run',
        '--spec',
        INPUT.bookSpecUid,
        '--pages',
        String(INPUT.pageCount),
        '--cover',
        INPUT.coverPath,
        '--contents',
        INPUT.contentsPath,
        '--qty',
        '1',
        '--ship',
        'fixtures/ship.sample.json',
      ],
      { env: sandboxEnv(jobsDir, api.baseUrl), stdin: 'n\n' },
    );
    assert.equal(res.code, 1, res.out);
    assert.ok(
      res.out.includes(`같은 입력으로 아직 끝나지 않은 작업이 있습니다 — ${existing.id}`),
      res.out,
    );
    assert.ok(res.out.includes(`resume ${existing.id}`), '이어서 하는 명령을 알려 준다');
    assert.deepEqual(
      await readdir(jobsDir),
      [`${existing.id}.json`],
      '새 작업 파일이 생기지 않는다',
    );
    assert.deepEqual(api.served, ['GET /book-specs'], '책 생성(POST /books)을 보내지 않는다');
  } finally {
    api.close();
    await rm(jobsDir, { recursive: true, force: true });
  }
});

test('확인을 기다리는 사이 견적이 만료되면 새 견적으로 다시 묻고, 그 뒤에만 주문한다', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bookprint-cli-'));
  const jobsDir = join(work, 'jobs');
  await mkdir(jobsDir);
  // "주문할까요?" 를 처음 물을 때 자식 프로세스의 시계를 견적 유효 시간 너머로 옮긴다
  const clock = join(work, 'clock.mjs');
  await writeFile(
    clock,
    `const RealDate = Date;
let offset = 0;
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
  static now() { return RealDate.now() + offset; }
};
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (offset === 0 && String(chunk).includes('주문할까요?')) offset = ${ESTIMATE_TTL_MS + 60_000};
  return write(chunk, ...rest);
};
`,
  );
  const api = await mockApi({
    'POST /orders/estimate': { status: 200, body: fixture('estimate_200.json').raw },
    'POST /orders': { status: 201, body: fixture('order_create_201.json').raw },
  });
  try {
    const job = await seedJob(jobsDir, 'finalize');
    const res = await runCli(['resume', job.id], {
      env: sandboxEnv(jobsDir, api.baseUrl),
      stdin: 'y\ny\n',
      preload: pathToFileURL(clock).href,
    });
    assert.equal(res.code, 0, res.out);
    assert.equal(count(res.out, '견적이 만료되어 다시 뽑았습니다'), 1, res.out);
    assert.equal(count(res.out, '주문할까요?'), 2, '새 금액으로 한 번 더 묻는다');
    assert.deepEqual(
      api.served,
      ['POST /orders/estimate', 'POST /orders/estimate', 'POST /orders'],
      '다시 뽑은 견적을 확인받은 뒤에만 주문한다',
    );
  } finally {
    api.close();
    await rm(work, { recursive: true, force: true });
  }
});

test('입력을 기다리는 중 Ctrl+C — 물음이 풀리고 종료 코드 130, 주문은 나가지 않는다', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bookprint-cli-'));
  const jobsDir = join(work, 'jobs');
  await mkdir(jobsDir);
  const preload = await sigintWhen(work, '주문할까요?');
  const api = await mockApi({
    'POST /orders/estimate': { status: 200, body: fixture('estimate_200.json').raw },
    'POST /orders': { status: 201, body: fixture('order_create_201.json').raw },
  });
  try {
    const job = await seedJob(jobsDir, 'finalize');
    const res = await runCli(['resume', job.id], {
      env: sandboxEnv(jobsDir, api.baseUrl),
      preload,
      keepStdinOpen: true,
    });
    assert.equal(res.code, 130, res.out);
    assert.deepEqual(api.served, ['POST /orders/estimate'], '주문은 나가지 않는다');
  } finally {
    api.close();
    await rm(work, { recursive: true, force: true });
  }
});

test('값을 묻는 중 Ctrl+C — 남은 입력을 기본값으로 채워 진행하지 않고 작업 파일도 만들지 않는다', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bookprint-cli-'));
  const jobsDir = join(work, 'jobs');
  await mkdir(jobsDir);
  const api = await mockApi({
    'GET /book-specs': { status: 200, body: fixture('bookspecs_list.json').raw },
  });
  try {
    const res = await runCli(
      ['run', '--spec', INPUT.bookSpecUid, '--pages', String(INPUT.pageCount)],
      {
        env: sandboxEnv(jobsDir, api.baseUrl),
        preload: await sigintWhen(work, '표지 PDF 경로'),
        keepStdinOpen: true,
      },
    );
    assert.equal(res.code, 130, res.out);
    assert.deepEqual(await readdir(jobsDir), [], '작업 파일을 만들지 않는다');
    assert.deepEqual(api.served, ['GET /book-specs'], '책 생성 요청을 보내지 않는다');
  } finally {
    api.close();
    await rm(work, { recursive: true, force: true });
  }
});
