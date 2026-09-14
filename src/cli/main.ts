import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  BookPrintApiError,
  BookPrintClient,
  BookPrintNetworkError,
  getCalculatedSize,
  listBookSpecs,
} from '../bookprint/index.js';
import { ConfigError, loadConfig, parseEnvironment } from '../config/env.js';
import type { JobInput, JobState, JobSummary, ParsedShipping, StepDeps } from '../flow/index.js';
import {
  FlowRuleError,
  getEstimate,
  newJob,
  nextStep,
  openPdf,
  PdfPrecheckError,
  parseShipping,
  runFlow,
  StepFailed,
  supplyNewPdf,
} from '../flow/index.js';
import { FileJobStore } from '../store/fileStore.js';
import { Prompter } from './prompts.js';
import {
  printCalculatedSize,
  printError,
  printEstimate,
  printJobStatus,
  printJobs,
  printOrderResult,
  printPdfHelp,
  printShippingWarnings,
  printSpecs,
  safeForTerminal,
} from './render.js';

const USAGE = `사용법
  specs [--spec <UID> --pages <N>]          판형 목록. --spec/--pages 를 주면 표지·내지 규격(mm)
  run [--spec --pages --cover --contents]   작업 생성 → 책 생성 → 업로드 → 최종화 → 견적 → (확인) → 주문
      [--title <제목>] [--ship <json>] [--qty <N>] [--dry-run]
                                            빈 인자는 물어본다. --dry-run 은 견적까지만
  resume <jobId> [--cover --contents]       멈춘 작업을 이어간다. 파일을 주면 교체하고 이어간다
  status <jobId> [--verbose] [--raw]        작업 상태와 단계별 기록. --raw 는 작업 파일 원본 JSON
  jobs                                      작업 목록
공통 옵션
  --env sandbox|live   기본 sandbox. live 는 확인 절차를 거친다
  --yes                프롬프트 생략 — 주문 확인도 생략한다 (live 는 --i-know-this-is-live 도 필요)
  --verbose            응답 원본을 그 자리에 펼친다`;

const SAMPLE = {
  spec: 'SQUAREBOOK_HC',
  pages: '24',
  cover: 'fixtures/SQUAREBOOK_HC_cover_24p.pdf',
  contents: 'fixtures/SQUAREBOOK_HC_inner_24p.pdf',
  ship: 'fixtures/ship.sample.json',
  qty: '1',
};

interface RunFlags {
  verbose: boolean;
  yes: boolean;
  dryRun: boolean;
}

let interrupted = false;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: 'string' },
      spec: { type: 'string' },
      pages: { type: 'string' },
      title: { type: 'string' },
      cover: { type: 'string' },
      contents: { type: 'string' },
      ship: { type: 'string' },
      qty: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'i-know-this-is-live': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg1] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  const KNOWN_COMMANDS = ['specs', 'run', 'resume', 'status', 'jobs'];
  if (!KNOWN_COMMANDS.includes(command)) {
    console.error(`알 수 없는 명령: ${command}\n`);
    console.log(USAGE);
    return 1;
  }

  const environment = parseEnvironment(values.env);
  const config = loadConfig(environment);
  const store = new FileJobStore(config.jobsDir);
  const client = new BookPrintClient({
    apiKey: config.apiKey,
    environment: config.environment,
    ...(config.baseUrlOverride ? { baseUrlOverride: config.baseUrlOverride } : {}),
  });
  const cancel = new AbortController();
  let cancelling = false;
  let prompterRef: Prompter | undefined;
  const onInterrupt = (): void => {
    interrupted = true;
    if (cancelling) {
      console.error('\n강제 종료합니다.');
      process.exit(130);
    }
    cancelling = true;
    cancel.abort(new Error('사용자가 취소했습니다 (Ctrl+C)'));
    prompterRef?.close();
    console.error('\n취소하는 중입니다. 진행 중인 요청을 끊고 작업 상태를 저장합니다…');
    console.error('  한 번 더 누르면 저장하지 않고 즉시 끝납니다.');
  };
  process.on('SIGINT', onInterrupt);

  const prompter = new Prompter(onInterrupt);
  prompterRef = prompter;
  const deps: StepDeps = { client, store, now: () => new Date(), signal: cancel.signal };
  const flags: RunFlags = { verbose: values.verbose, yes: values.yes, dryRun: values['dry-run'] };

  try {
    if (environment === 'live' && (command === 'run' || command === 'resume')) {
      if (!(await confirmLive(prompter, values.yes, values['i-know-this-is-live']))) return 1;
    }

    switch (command) {
      case 'specs': {
        if (values.spec && values.pages) {
          const res = await getCalculatedSize(client, values.spec, Number(values.pages), {
            signal: cancel.signal,
          });
          printCalculatedSize(res.data);
        } else {
          const res = await listBookSpecs(client, { signal: cancel.signal });
          printSpecs(res.data);
          console.log(`\n${config.environment} · 키 ${config.apiKeyMasked}`);
        }
        return 0;
      }
      case 'run': {
        const input = await collectRunInput(values, prompter, client, cancel.signal);
        if (!input) return 1;
        const resumable = await findResumable(store, input);
        if (resumable) {
          console.log(
            safeForTerminal(
              `같은 입력으로 아직 끝나지 않은 작업이 있습니다 — ${resumable.id} (다음 단계 ${resumable.next}, 책 ${resumable.bookUid ?? '-'})`,
            ),
          );
          console.log(`  이어서 하려면  resume ${resumable.id}`);
          const proceed =
            values.yes || (await prompter.confirm('새 작업을 만들까요? (책이 하나 더 생깁니다)'));
          if (!proceed) return 1;
        }
        const job = newJob(input, {
          env: config.environment,
          now: () => new Date(),
          uuid: randomUUID,
        });
        await store.save(job);
        console.log(`작업 ${job.id} 생성 (${config.environment}, 키 ${config.apiKeyMasked})`);
        return await runAndReport(job, deps, prompter, flags);
      }
      case 'resume': {
        const job = arg1 ? await store.get(arg1) : null;
        if (!arg1 || !job) {
          printError(
            arg1 ? `작업을 찾을 수 없습니다: ${arg1}` : 'resume 에는 jobId 가 필요합니다',
            `jobs 로 목록을 보세요 (${config.jobsDir})`,
          );
          return 1;
        }
        if (job.env !== config.environment) {
          printError(
            `작업 ${job.id} 는 ${job.env} 환경의 것입니다. --env ${job.env} 로 실행하세요`,
          );
          return 1;
        }
        if (values.cover || values.contents) {
          const replaced = await replaceFiles(job, deps, values, flags.verbose);
          if (!replaced) return 2;
        }
        if (nextStep(job) === null) {
          printJobStatus(job, flags.verbose);
          console.log('\n이미 완주한 작업입니다.');
          return 0;
        }
        console.log(`작업 ${job.id} 재개 (${config.environment}, 다음 단계 ${nextStep(job)})\n`);
        return await runAndReport(job, deps, prompter, flags);
      }
      case 'status': {
        if (!arg1) {
          printError('status 에는 jobId 가 필요합니다');
          return 1;
        }
        const job = await store.get(arg1);
        if (!job) {
          printError(
            `작업을 찾을 수 없습니다: ${arg1}`,
            `jobs 로 목록을 보세요 (${config.jobsDir})`,
          );
          return 1;
        }
        if (values.raw) {
          console.log(JSON.stringify(job, null, 2));
          return 0;
        }
        printJobStatus(job, flags.verbose);
        return 0;
      }
      case 'jobs': {
        printJobs(await store.list());
        return 0;
      }
      default:
        printError(`모르는 명령: ${command}`);
        console.log(USAGE);
        return 1;
    }
  } finally {
    prompter.close();
  }
}

async function collectRunInput(
  v: {
    spec?: string;
    pages?: string;
    title?: string;
    cover?: string;
    contents?: string;
    ship?: string;
    qty?: string;
    yes: boolean;
  },
  prompter: Prompter,
  client: BookPrintClient,
  signal: AbortSignal,
): Promise<JobInput | null> {
  const ask = async (q: string, flag: string | undefined, def: string | undefined) => {
    const answer = flag ?? (v.yes ? (def ?? '') : await prompter.ask(q, def));
    signal.throwIfAborted();
    return answer;
  };

  const spec = await ask('판형 UID', v.spec, SAMPLE.spec);
  const pagesText = await ask('페이지 수', v.pages, SAMPLE.pages);
  const pageCount = Number(pagesText);
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    printError(`페이지 수는 양의 정수여야 합니다: ${pagesText}`);
    return null;
  }

  const specs = (await listBookSpecs(client, { signal })).data;
  const found = specs.find((s) => s.bookSpecUid === spec);
  if (!found) {
    printError(
      `판형을 찾을 수 없습니다: ${spec}`,
      `이 계정의 판형: ${specs.map((s) => s.bookSpecUid).join(', ')}`,
    );
    return null;
  }
  const inRange = pageCount >= found.pageMin && pageCount <= found.pageMax;
  const onStep = (pageCount - found.pageMin) % found.pageIncrement === 0;
  if (!inRange || !onStep) {
    printError(
      `${spec} 은(는) ${found.pageMin}~${found.pageMax}쪽, ${found.pageIncrement}쪽 단위입니다: ${pageCount}쪽은 만들 수 없습니다`,
      '서버도 책 생성 시점에 같은 이유로 거부합니다',
    );
    return null;
  }

  const sampleOk = spec === SAMPLE.spec && pageCount === Number(SAMPLE.pages);
  if (!sampleOk && !v.cover && !v.contents && !v.yes) {
    console.log(
      `  동봉 샘플 PDF 는 ${SAMPLE.spec} ${SAMPLE.pages}쪽용이라 이 책에는 맞지 않습니다. 이 책에 맞는 PDF 경로를 입력하세요.`,
    );
  }
  const cover = await ask('표지 PDF 경로', v.cover, sampleOk ? SAMPLE.cover : undefined);
  const contents = await ask('내지 PDF 경로', v.contents, sampleOk ? SAMPLE.contents : undefined);
  if (!cover || !contents) {
    printError('표지와 내지 PDF 경로가 필요합니다 (--cover, --contents)');
    printPdfHelp(spec, pageCount);
    return null;
  }
  for (const [label, p] of [
    ['표지', cover],
    ['내지', contents],
  ] as const) {
    try {
      await openPdf(p);
    } catch (err) {
      if (err instanceof PdfPrecheckError) {
        printError(`${label} PDF 사전 검사 실패: ${err.message}`);
        printPdfHelp(spec, pageCount);
        return null;
      }
      throw err;
    }
  }
  const qtyText = await ask('수량', v.qty, SAMPLE.qty);
  const quantity = Number(qtyText);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    printError(`수량은 양의 정수여야 합니다: ${qtyText}`, '서버가 받는 범위는 1~200 입니다');
    return null;
  }
  const shipPath = await ask('배송지 JSON 경로', v.ship, SAMPLE.ship);
  const parsed = await readShipping(shipPath);
  if (!parsed) return null;
  if (parsed.warnings.length > 0) {
    printShippingWarnings(parsed.warnings);
    if (!v.yes && !(await prompter.confirm('이대로 진행할까요?'))) {
      printError('배송지를 고친 뒤 다시 실행하세요', shipPath);
      return null;
    }
  }
  const shipping = parsed.shipping;
  return {
    bookSpecUid: spec,
    pageCount,
    title: v.title ?? `bookprint-pdf-demo ${spec} ${pageCount}p`,
    coverPath: cover,
    contentsPath: contents,
    quantity,
    shipping,
  };
}

async function readShipping(path: string): Promise<ParsedShipping | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    printError(`배송지 파일을 읽을 수 없습니다: ${path}`, `예시: ${SAMPLE.ship}`);
    return null;
  }
  try {
    return parseShipping(JSON.parse(text), path);
  } catch (err) {
    if (err instanceof FlowRuleError || err instanceof SyntaxError) {
      printError(err.message, `예시: ${SAMPLE.ship}`);
      return null;
    }
    throw err;
  }
}

async function replaceFiles(
  job: JobState,
  deps: StepDeps,
  values: { cover?: string; contents?: string },
  verbose: boolean,
): Promise<boolean> {
  for (const [kind, path] of [
    ['cover', values.cover],
    ['contents', values.contents],
  ] as const) {
    if (!path) continue;
    const label = kind === 'cover' ? '표지' : '내지';
    try {
      const how = await supplyNewPdf(job, deps, kind, path);
      console.log(
        how === 'replaced'
          ? `${label} 교체 완료 — ${path}`
          : `${label} 경로 변경 — ${path} (다음 단계가 올립니다)`,
      );
    } catch (err) {
      if (err instanceof StepFailed) {
        printJobStatus(err.job, verbose);
        explainFailure(err);
        return false;
      }
      if (err instanceof FlowRuleError) {
        printError(err.message);
        return false;
      }
      if (err instanceof BookPrintApiError || err instanceof BookPrintNetworkError) {
        printJobStatus(job, verbose);
        printError(
          `${label} 확인 실패 — ${err instanceof BookPrintApiError ? `${err.status} ${err.errorCode ?? ''} ${err.userMessage()}` : err.message}`.trim(),
          `resume ${job.id} --${kind} ${path} 를 다시 실행하세요`,
        );
        return false;
      }
      throw err;
    }
  }
  return true;
}

async function findResumable(store: FileJobStore, input: JobInput): Promise<JobSummary | null> {
  for (const row of await store.list()) {
    if (row.next === 'done') continue;
    const job = await store.get(row.id);
    if (!job) continue;
    if (
      job.input.bookSpecUid === input.bookSpecUid &&
      job.input.pageCount === input.pageCount &&
      job.input.coverPath === input.coverPath &&
      job.input.contentsPath === input.contentsPath
    ) {
      return row;
    }
  }
  return null;
}

async function runAndReport(
  job: JobState,
  deps: StepDeps,
  prompter: Prompter,
  flags: RunFlags,
): Promise<number> {
  try {
    const pending = job.steps.createOrder.status;
    if (pending === 'UNKNOWN' || pending === 'RUNNING') {
      if (flags.dryRun) {
        printJobStatus(job, flags.verbose);
        console.log(
          `\n--dry-run: 응답을 받지 못한 주문이 있어 멈췄습니다. 확인하려면  resume ${job.id}`,
        );
        return 0;
      }
      console.log('응답을 받지 못한 주문이 있습니다 — 같은 멱등 키로 먼저 확인합니다.');
      await runFlow(job, deps);
    }
    for (;;) {
      await runFlow(job, deps, { until: 'estimate' });
      if (nextStep(job) !== 'createOrder') break;
      const est = getEstimate(job);
      if (est) printEstimate(est, job.env);
      if (flags.dryRun) {
        printJobStatus(job, flags.verbose);
        console.log(`\n--dry-run: 주문 직전에서 멈췄습니다. 주문하려면  resume ${job.id}`);
        return 0;
      }
      if (!flags.yes && !(await prompter.confirm('주문할까요?'))) {
        printJobStatus(job, flags.verbose);
        console.log(`\n주문하지 않았습니다. 나중에 주문하려면  resume ${job.id}`);
        return 0;
      }
      const quotedAt = job.steps.estimate.finishedAt;
      await runFlow(job, deps, { until: 'estimate' });
      if (job.steps.estimate.finishedAt !== quotedAt) {
        console.log('\n견적이 만료되어 다시 뽑았습니다.');
        continue;
      }
      await runFlow(job, deps);
      break;
    }
    printJobStatus(job, flags.verbose);
    if (job.orderUid) printOrderResult(job);
    return 0;
  } catch (err) {
    if (err instanceof StepFailed) {
      printJobStatus(err.job, flags.verbose);
      if (deps.signal?.aborted) {
        printError(
          `${err.step} 을(를) 취소했습니다.`,
          `resume ${err.job.id} — 업로드는 올라갔는지 확인한 뒤, 나머지는 같은 멱등 키로 이어갑니다`,
        );
        return 130;
      }
      const est = err.step === 'estimate' ? getEstimate(err.job) : null;
      if (est) printEstimate(est, err.job.env);
      explainFailure(err);
      return 2;
    }
    throw err;
  }
}

function explainFailure(err: StepFailed): void {
  const job = err.job;
  const st = job.steps[err.step];
  const isUpload = err.step === 'uploadCover' || err.step === 'uploadContents';
  if (st.status === 'UNKNOWN' && st.error?.errorCode === 'ERR_IDEMPOTENCY_KEY_MISMATCH') {
    printError(
      `${err.step}: 이 작업의 주문이 서버에 이미 있습니다. 그 뒤 입력(배송지·수량 등)이 바뀌어 같은 요청으로 볼 수 없습니다.`,
      `새 주문을 만들지 않았습니다 — 만들면 주문이 둘이 됩니다. 포털에서 externalRef=${job.id} 로 기존 주문을 확인하세요. 입력을 원래대로 되돌리면 resume ${job.id} 가 기존 주문을 그대로 돌려받습니다`,
    );
    return;
  }
  if (st.status === 'UNKNOWN') {
    const portal =
      err.step === 'createOrder' ? ` (포털에서 externalRef=${job.id} 로도 찾을 수 있습니다)` : '';
    printError(
      `${err.step} 응답을 받지 못했습니다. 서버에 반영됐을 수 있습니다.`,
      isUpload
        ? `resume ${job.id} 가 업로드 여부를 확인한 뒤 없을 때만 다시 올립니다`
        : `resume ${job.id} 가 같은 멱등 키로 재전송합니다 — 서버가 받았었다면 같은 결과가 돌아옵니다${portal}`,
    );
    return;
  }
  if (st.error?.errorCode === 'ERR_INSUFFICIENT_CREDIT') {
    const topUp =
      job.env === 'sandbox'
        ? 'node --env-file=.env --import tsx scripts/charge-sandbox.ts <금액> 로 채우거나\n' +
          '        https://api.sweetbook.com/partner/ > 충전금 > 충전 에서 채운'
        : 'https://api.sweetbook.com/partner/ > 충전금 > 충전 에서 결제해 채운';
    printError(
      `${err.step}: 충전금이 부족합니다`,
      `${topUp} 뒤  resume ${job.id}  — 견적을 다시 뽑고 주문합니다`,
    );
    return;
  }
  printError(
    `${err.step} 실패`,
    '위 기록의 errors/fieldErrors 를 보고 입력을 고친 뒤 다시 실행하세요',
  );
  if (isUpload && (st.error?.status === 400 || st.error?.status === null)) {
    printPdfHelp(job.input.bookSpecUid, job.input.pageCount);
  }
}

async function confirmLive(
  prompter: Prompter,
  yes: boolean,
  acknowledged: boolean,
): Promise<boolean> {
  if (yes) {
    if (acknowledged) return true;
    printError('live 를 무인 실행하려면 --yes 와 --i-know-this-is-live 를 함께 주어야 합니다');
    return false;
  }
  const answer = await prompter.ask(
    'live 환경입니다. 실제 인쇄·과금됩니다. 계속하려면 yes 를 입력',
  );
  return answer === 'yes';
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = interrupted ? 130 : code;
  })
  .catch((err: unknown) => {
    if (interrupted) {
      printError('취소했습니다');
      process.exitCode = 130;
      return;
    }
    if (err instanceof ConfigError) {
      printError(err.message);
    } else if (err instanceof BookPrintApiError) {
      const hint =
        err.errorCode === 'ERR_ENV_MISMATCH'
          ? '키가 이 환경의 것이 아닙니다. --env 와 .env 의 변수(SWEETBOOK_SANDBOX_API_KEY / SWEETBOOK_LIVE_API_KEY)를 맞추세요'
          : err.errorCode === 'ERR_UNAUTHORIZED'
            ? '키가 거부됐습니다. 포털에서 폐기됐거나 잘못 복사됐을 수 있습니다'
            : undefined;
      printError(`${err.status} ${err.errorCode ?? ''} ${err.userMessage()}`.trim(), hint);
    } else if (err instanceof BookPrintNetworkError) {
      printError(err.message, '네트워크·방화벽·프록시를 확인하세요');
    } else {
      printError(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  });
