# bookprint-pdf-demo

[BookPrint API](https://api.sweetbook.com/docs/) 로 인쇄 주문을 자동화하려는 파트너를 위한 데모입니다. 책 생성 → 표지·내지 PDF 업로드 → 최종화 → 견적 → 주문의 여섯 단계를 CLI 로 실행해 볼 수 있고, API 호출 모듈과 주문 흐름은 **폴더째 복사해 자기 서비스에 넣을 수 있게** 만들어져 있습니다.

**이것은 SDK 가 아니라 참조 구현입니다.** 그대로 운영에 올리는 것이 아니라 읽고 가져가는 코드이며, 실제 서비스에 쓰려면 파일 기반 작업 저장소(`store/`)를 자기 DB 로 바꿔야 합니다. **PDF 를 만들어 주지도 않습니다** — 규격에 맞는 표지·내지 PDF 는 파트너가 준비합니다 ([PDF 준비](#pdf-준비)).

대응 API: **BookPrint API v1** · Sandbox 에서 마지막으로 확인한 날: **2026-09-14** (Node 24)

## 목차

- [특징](#특징)
- [요구 사항](#요구-사항)
- [PDF 준비](#pdf-준비)
- [설치](#설치)
- [빠른 시작](#빠른-시작)
- [사용법](#사용법)
  - [CLI](#cli)
  - [라이브러리로 쓰기](#라이브러리로-쓰기)
- [설정](#설정)
- [동작 방식](#동작-방식)
  - [멱등성](#멱등성) · [재시도](#재시도) · [단계 상태](#단계-상태) · [견적 게이트](#견적-게이트) · [로컬 검사](#로컬-검사) · [취소](#취소) · [주문 이후](#주문-이후)
- [문제 해결](#문제-해결)
- [프로젝트 구조](#프로젝트-구조)
- [테스트](#테스트)
  - [유지보수 스크립트](#유지보수-스크립트)
- [기여](#기여)
- [보안과 개인정보](#보안과-개인정보)
- [라이선스](#라이선스)

## 특징

- **같은 작업 안에서는 돈이 두 번 나가지 않습니다** — 책 생성·최종화·주문에 멱등 키를 미리 발급해 재전송·`resume` 때 같은 키를 씁니다. 멱등이 없는 PDF 업로드는 서버에 있는지 확인한 뒤에만 다시 올립니다. 작업 파일이 남아 있고 서버의 키 보관 기간 안일 때의 보장입니다 ([조건](#멱등성))
- **멈춘 자리에서 이어갑니다** — 작업 상태를 단계별로 저장하고 `resume` 으로 재개합니다. 잔액 부족·PDF 규격 오류·네트워크 단절 모두 같은 방법으로 복구합니다
- **서버에 보내기 전에 잡습니다** — 없는 파일·PDF 가 아닌 파일, 판형에 없는 쪽수, 배송지 필수 항목·길이·키 오타를 책을 만들기 전에 로컬에서 검사합니다. PDF 의 쪽수·규격은 서버가 판정합니다
- **Sandbox / Live 분리** — 환경마다 키 변수가 다르고, Live 에서 인쇄·과금으로 이어지는 `run`·`resume` 은 명시적 확인 없이는 실행되지 않습니다

## 요구 사항

- Node.js **22.9 이상** (`.env` 가 없어도 안내 메시지가 나오도록 `--env-file-if-exists` 사용). 검증은 Node 24 에서 했습니다
- BookPrint **Sandbox API 키** — [파트너 포털](https://api.sweetbook.com/partner/) 에 가입한 뒤 `설정 > API Key > 새 API Key 발급 > Sandbox`. **발급 순간에만 전체 값이 보이므로** 그때 복사해 둡니다. Live 키는 스위트북과 사업 협의 후 열립니다
- **충전금** — 주문은 충전금에서 즉시 차감됩니다. `파트너 포털 > 충전금 > 충전` 에서 채우고(Sandbox 는 실제 비용 없는 가상 충전금이라 원하는 만큼), Sandbox 는 [스크립트](#유지보수-스크립트)로도 채울 수 있습니다
- 런타임 의존성은 없습니다 — Node.js 내장 `fetch` 만 씁니다

## PDF 준비

이 데모는 PDF 를 만들지 않습니다. 처음에는 동봉 샘플(`fixtures/`, 판형 2종 24쪽)로 돌려 보세요. 샘플은 [PDF 제작 가이드](https://api.sweetbook.com/pdf-guideline/)에서 받을 수 있는 가이드 PDF(안내선만 그려진 빈 페이지)이고, 내지는 같은 페이지를 24쪽으로 늘린 것입니다.

실제 인쇄용 PDF 는 규격을 맞춰야 합니다.

- 규격(mm)은 `specs --spec <UID> --pages <N>` 또는 [계산 크기 API](https://api.sweetbook.com/docs/concepts/pdf-size-api/) 로 확인하고, 인쇄 규칙은 [PDF 제작 가이드](https://api.sweetbook.com/pdf-guideline/)를 따릅니다
- **표지는 제본과 무관하게 펼침면 1페이지**(뒤표지+책등+앞표지)입니다
- **내지 쪽수는 책 생성 시 `pageCount` 와 같아야** 합니다
- 규격이 틀리면 서버가 위반 항목 전부를 400 으로 돌려주고, 데모는 그것을 그대로 보여 줍니다

## 설치

```bash
git clone https://github.com/sweet-book/bookprint-pdf-demo.git
cd bookprint-pdf-demo
npm install
cp .env.example .env    # SWEETBOOK_SANDBOX_API_KEY 를 채웁니다 (발급 경로는 요구 사항 절)
```

`npm install` 로 설치되는 것은 개발 도구(TypeScript · `@types/node` · tsx · Biome · dependency-cruiser)뿐입니다. npm 11 이상에서 `install-scripts ... esbuild` 경고가 뜰 수 있으나 무시해도 됩니다 — 데모 실행에 영향이 없습니다.

## 빠른 시작

```bash
npm run cli -- run
```

동봉 샘플 PDF 로 책을 만들고 견적을 보여 준 뒤 **"주문할까요?"** (기본값 아니오)에서 멈춥니다.

- 빈 인자는 프롬프트로 묻고, Enter 만 치면 샘플 값이 들어갑니다(제목은 묻지 않습니다 — `--title`)
- Sandbox 는 sandbox 충전금을 쓰며 실제 인쇄는 일어나지 않습니다
- 주문하지 않은 책은 Sandbox 에 남으니 시험을 마치면 [정리](#유지보수-스크립트)하세요

```
책 생성 ─→ 표지 업로드 ─→ 내지 업로드 ─→ 최종화 ─→ 견적 ─→ 주문
```

**최종화**는 표지·내지가 모두 올라간 책을 주문할 수 있는 상태(`finalized`)로 바꾸는 호출입니다 ([Books API — PDF](https://api.sweetbook.com/docs/api/books-pdf/)).

견적까지만 실행한 실제 출력입니다 (`run --dry-run --yes`, 기록 일부는 `…` 로 줄였습니다):

```
작업 j_20260911-0909-a2f75529 생성 (sandbox, 키 SBXXXXXXXXXX.****)

  견적  상품 12,600 + 배송 2,727 = 15,327 KRW  (1권)
        → 충전금 차감 16,850 KRW (VAT 포함, 10원 절사)
  잔액  99,000 → 82,150   충분
  [sandbox] 실제 인쇄·배송 없음. 주문은 PDF_READY 에서 멈춥니다.

작업 j_20260911-0909-a2f75529  env=sandbox  책=bk_7F1n54jwOyic  주문=-
  판형 SQUAREBOOK_HC  24p  "bookprint-pdf-demo SQUAREBOOK_HC 24p"
  [1/6] 책 생성          DONE      key=5a10e66c…
  [2/6] 표지 PDF 업로드  DONE
  [3/6] 내지 PDF 업로드  DONE
  [4/6] 최종화           DONE      key=ca000883…
  [5/6] 견적             DONE
  [6/6] 주문             PENDING   key=3a66332e…
기록
[1/6] 책 생성
  → POST /books   {"title":"bookprint-pdf-demo SQUAREBOOK_HC 24p","bookSpecUid":"SQUAREBOOK_HC","creationTyp…
  ← 201  0.2s
     원본: jobs/j_20260911-0909-a2f75529.json#log[0]
[2/6] 표지 PDF 업로드
  → POST /books/bk_7F1n54jwOyic/pdf-cover   multipart file=SQUAREBOOK_HC_cover_24p.pdf (837 B)
  ← 201  0.1s
  …
--dry-run: 주문 직전에서 멈췄습니다. 주문하려면  resume j_20260911-0909-a2f75529
```

`npm run cli -- specs` 는 계정에서 쓸 수 있는 판형을 보여 줍니다:

```
판형                     커버       내지(mm)     페이지             기본가
PHOTOBOOK_A4_SC          Softcover  210×297      24~200 (2p 단위)   12,400 KRW
PHOTOBOOK_A5_SC          Softcover  148×210      50~200 (2p 단위)   11,900 KRW
SQUAREBOOK_HC            Hardcover  243×248      24~130 (2p 단위)   12,600 KRW
SQUAREBOOK_SC            Softcover  243×248      24~130 (2p 단위)   10,800 KRW

sandbox · 키 SBXXXXXXXXXX.****
```

## 사용법

### CLI

```bash
npm run cli -- <명령> [옵션]
```

| 명령 | 설명 |
|---|---|
| `specs [--spec <UID> --pages <N>]` | 판형 목록. `--spec`·`--pages` 를 주면 표지·내지 PDF 규격(mm) |
| `run [옵션]` | 작업 생성부터 주문까지. 빈 인자는 묻습니다 |
| `resume <jobId> [--cover --contents]` | 멈춘 작업을 이어갑니다. PDF 를 주면 교체하고 이어갑니다. **주문 단계에 닿으면 확인을 묻고, `--yes` 는 그 확인도 건너뜁니다** |
| `status <jobId> [--verbose] [--raw]` | 단계별 상태와 요청·응답 기록. `--raw` 는 작업 파일 원본 JSON |
| `jobs` | 작업 목록 |

`run` 옵션

| 옵션 | 설명 |
|---|---|
| `--spec <UID>` `--pages <N>` | 판형과 내지 쪽수 |
| `--cover <pdf>` `--contents <pdf>` | 표지·내지 PDF |
| `--title <제목>` `--qty <N>` | 책 제목(생략하면 `bookprint-pdf-demo <판형> <쪽수>p`), 주문 수량 |
| `--ship <json>` | 배송지 파일. [`fixtures/ship.sample.json`](fixtures/ship.sample.json) 참고 |
| `--dry-run` | 견적까지만. 주문은 나중에 `resume` |

공통 옵션

| 옵션 | 설명 |
|---|---|
| `--env sandbox\|live` | 환경. 기본 sandbox |
| `--verbose` | 응답 원본을 그 자리에 펼칩니다 |
| `--yes` | 프롬프트를 생략합니다. **주문 확인도 생략합니다** — `run`·`resume` 모두. live 는 `--i-know-this-is-live` 도 필요합니다 |

- **무인 실행에서 주문을 내지 않으려면 `--dry-run --yes`** 를 쓰세요 — `--yes` 만 주면 주문까지 갑니다
- `run` 은 같은 판형·쪽수·PDF 로 끝나지 않은 작업이 있으면 `resume` 을 권하고 새 작업을 만들지 묻습니다(기본값 아니오). `--yes` 면 묻지 않고 새로 만들므로, `--dry-run --yes` 를 되풀이하면 그때마다 Sandbox 에 책이 한 권씩 생깁니다
- 종료 코드: 정상 `0`, 인자·설정 오류 `1`, 단계 실패 `2`, Ctrl+C `130`(요청 중이든 입력을 기다리는 중이든). 인자 없이 `npm run cli` 를 치면 사용법이 나옵니다

명령 예시는 bash 기준입니다. PowerShell 에서는 줄 끝 역슬래시(`\`)를 백틱(`` ` ``)으로 바꾸세요.

```bash
# 내 PDF 로
npm run cli -- run --spec SQUAREBOOK_HC --pages 24 \
  --cover cover.pdf --contents inner.pdf --ship ship.json --qty 2 --title "내 책"

# 견적까지만 보고, 나중에 주문
npm run cli -- run --dry-run
npm run cli -- resume <jobId>

# 규격 오류로 멈춘 작업에 고친 PDF 를 넣어 이어가기
npm run cli -- resume <jobId> --contents inner-fixed.pdf
```

주고받은 요청·응답 원본은 `jobs/<jobId>.json` 에 남습니다. 이 파일에는 배송지가 들어 있습니다 — [보안과 개인정보](#보안과-개인정보).

### 라이브러리로 쓰기

`src/bookprint/` 와 `src/flow/` 를 프로젝트에 복사하고, 작업 저장소(`JobStore` — `get`·`save`·`list` 세 메서드)를 자기 DB 로 구현하면 됩니다. 우선은 동봉된 파일 저장소(`src/store/fileStore.ts`)를 같이 가져가도 됩니다.

흐름이 실제로 부르는 것은 **`save` 하나**입니다. `get`·`list` 는 이 데모의 CLI 가 작업을 찾아보는 데 쓰므로, 재개 기능을 직접 만들지 않을 거라면 스텁이어도 됩니다. `list` 를 구현한다면 돌려줄 `JobSummary` 의 모양은 `flow/store.ts` 에 있고, 그중 `next` 는 같이 export 되는 `nextStep(job)` 으로 계산합니다.

아래 코드는 복사한 `bookprint/`·`flow/`·`store/` 와 **같은 폴더 깊이**에 둡니다. `createBook`·`createOrder` 는 두 폴더 모두에 있으니 한 파일에서 같이 쓸 때는 별칭을 주세요.

```ts
import { randomUUID } from 'node:crypto';
import { BookPrintClient } from './bookprint/index.js';
import { newJob, nextStep, runFlow } from './flow/index.js';
import { FileJobStore } from './store/fileStore.js';

const client = new BookPrintClient({
  apiKey: process.env.SWEETBOOK_SANDBOX_API_KEY ?? '',
  environment: 'sandbox',
});
const store = new FileJobStore('./jobs'); // 자기 DB 구현으로 바꾸는 자리입니다
const deps = { client, store, now: () => new Date() };

const job = newJob(
  {
    bookSpecUid: 'SQUAREBOOK_HC',
    pageCount: 24,
    title: '내 책',
    coverPath: 'cover.pdf',
    contentsPath: 'inner.pdf',
    quantity: 1,
    shipping: { recipientName: '홍길동', recipientPhone: '01012345678', postalCode: '06236', address1: '서울시 …' },
  },
  { env: 'sandbox', now: () => new Date(), uuid: randomUUID },
);
await store.save(job);

// 견적까지 실행하고 멈춥니다
await runFlow(job, deps, { until: 'estimate' });

// 사용자가 확인하면 나머지(주문)를 실행합니다
await runFlow(job, deps);
console.log(nextStep(job)); // null 이면 완료. 주문 번호는 job.orderUid
```

`runFlow` 는 넘긴 `job` 을 제자리에서 갱신하고 저장소에 저장합니다.

- 단계가 실패하면 `StepFailed` 가 던져지고 원인은 `job.steps[<단계>].error` 에 남습니다
- 같은 `job` 으로 `runFlow` 를 다시 부르면 끝난 단계는 건너뛰고 실패한 단계부터 이어갑니다
- 예외 하나 — 주문을 보내기 전 견적이 10분(`ESTIMATE_TTL_MS`)보다 오래됐으면 견적을 다시 뽑습니다

복사한 코드는 **ESM** 이고 import 경로에 `.js` 확장자를 씁니다. 실행하려면 `tsc` 빌드나 `tsx` 같은 로더가 필요합니다. 기존 프로젝트의 설정에 맞추는 법은 아래를 펼쳐 보세요.

<details>
<summary>기존 프로젝트에 넣을 때 — package.json·tsconfig 설정</summary>

가져가는 쪽에서 준비할 것은 넷입니다.

- `package.json` 에 `"type": "module"` — 없으면 `tsc --init` 기본값(`verbatimModuleSyntax`) 아래서 파일마다 오류가 납니다. CommonJS 서비스라면 `"type"` 은 그대로 두고 `verbatimModuleSyntax` 를 끄면 컴파일·실행됩니다(이때 위 예제의 top-level `await` 는 async 함수로 감쌉니다)
- 개발 의존성으로 **`@types/node`** (+ `"types": ["node"]`) — 런타임 의존성은 없지만 컴파일에는 필요합니다
- `tsconfig.json` 의 `"module": "NodeNext"` 또는 `"moduleResolution": "bundler"`
- `lib` 가 **ES2022 이상** — `Error` 의 `cause` 를 씁니다. `tsc --init` 기본값은 해당하고, 기존 서비스가 ES2020 이하라면 `"lib": ["es2022"]` 를 넣습니다(`target` 은 그대로 둬도 됩니다)

`"strict": true` 는 권장이되 필수가 아닙니다. 끄고도 컴파일되지만, `tsc --init` 기본값에 있는 `exactOptionalPropertyTypes` 는 `strictNullChecks` 가 있어야 하므로 `strict` 를 끌 때 함께 끄거나 `strictNullChecks` 를 남겨 두세요. 켜지 못하는 옵션이 셋 있습니다 — `erasableSyntaxOnly`, `noPropertyAccessFromIndexSignature`, `isolatedDeclarations`.

import 경로가 `.js` 라서 Node 의 타입 스트리핑(`node app.ts`)으로는 해석되지 않습니다. `tsc` 로 빌드해 `node dist/…` 로 돌리거나 `tsx` 같은 로더를 쓰세요.

</details>

## 설정

환경변수는 `.env` 파일로 줍니다 (`.env.example` 참고).

| 변수 | 필수 | 설명 |
|---|---|---|
| `SWEETBOOK_SANDBOX_API_KEY` | Sandbox 사용 시 | Sandbox 키. 형식 `SB{10자}.{32자}` |
| `SWEETBOOK_LIVE_API_KEY` | Live 사용 시 | Live 키. 없으면 `--env live` 는 기동 시 실패합니다 |
| `BOOKPRINT_JOBS_DIR` | | 작업 파일 위치. 기본 `./jobs` |
| `BOOKPRINT_BASE_URL_OVERRIDE` | | 기저 URL 교체. **sandbox 에서만** 먹습니다 — 로컬 모의 서버로 시험할 때 씁니다 |

키 형식에는 환경 정보가 없어 변수 이름으로 환경을 나눕니다. 키는 로그·작업 파일·오류 메시지 어디에도 기록되지 않으며, 표시할 때는 앞 12자만 보입니다.

**Live 환경.** `--env live` 는 실제 인쇄와 과금이 일어납니다. 대화식 실행에서는 `yes` 입력을, 무인 실행에서는 `--yes --i-know-this-is-live` 를 요구합니다. 작업은 만들어진 환경에 묶여 있어 sandbox 작업을 live 로 `resume` 할 수 없습니다.

## 동작 방식

### 멱등성

- 책 생성·최종화·주문은 작업을 만들 때 멱등 키를 미리 발급하고, 재시도·`resume` 마다 같은 키를 보냅니다. 서버가 이미 처리했다면 첫 응답을 그대로 돌려주므로 책·주문이 하나 더 생기지 않습니다
- 서버는 검증 실패(400)·없는 대상(404)·충전금 부족(402)·5xx 응답을 키에 묶지 않습니다([멱등성](https://api.sweetbook.com/docs/operations/idempotency/)). 그래서 거부된 뒤 입력을 고쳐 다시 보낼 때도 같은 키를 씁니다
- 키가 다른 본문에 이미 묶여 있으면(422 `ERR_IDEMPOTENCY_KEY_MISMATCH`) 그때만 새 키를 만듭니다. 단, 응답을 못 받은 요청을 재전송했는데 422 가 오면 서버가 원 요청을 이미 처리했다는 뜻이라, 새 키를 만들지 않고 멈춥니다

**"돈이 두 번 나가지 않는다"는 아래 조건에서의 보장입니다.**

- **같은 작업을 이어갈 때만** 같은 키가 쓰입니다. 키는 작업 파일에 있으므로, 작업 파일을 지우거나 잃으면 보장도 사라집니다
- `run` 은 언제나 새 작업·새 키로 시작합니다. 응답을 못 받은 주문이 있는데 `resume` 대신 `run` 을 치면 주문이 둘이 될 수 있습니다. `run` 은 같은 판형·쪽수·PDF 로 끝나지 않은 작업이 있으면 먼저 알려 주고 새로 만들지 묻지만, `--yes` 면 묻지 않습니다
- 재전송은 서버가 첫 응답을 보관하는 동안이어야 합니다([멱등성](https://api.sweetbook.com/docs/operations/idempotency/) 문서 기준 24시간)

### 재시도

- 다시 보내는 경우는 넷뿐입니다 — **429 · 500(`ERR_INTERNAL_ERROR` 이거나 오류 코드가 없을 때) · 멱등 락 409(오류 코드 없음) · 응답을 못 받은 경우**
- 502·503·504 는 다시 보내지 않습니다. 서버가 받았는지 알 수 없어 `UNKNOWN` 으로 두고, `resume` 이 확인부터 합니다
- 대기는 지수 백오프 1·2·4초(±20% 흔들림, 상한 30초, 최대 4회 시도)이고 `Retry-After` 가 오면 그대로 따릅니다. 요청 하나에 총 120초를 넘는 대기는 하지 않고 멈춥니다 — `resume` 으로 이어갑니다
- 멱등 키가 없는 POST 는 재시도하지 않습니다. 부작용이 없는 견적만 예외입니다
- PDF 업로드는 멱등을 지원하지 않아 자동 재시도하지 않습니다. 응답이 유실되면 서버에 올라갔는지 확인(`probePdf`)한 뒤 없을 때만 다시 올립니다

### 단계 상태

각 단계는 `PENDING` `RUNNING` `DONE` `FAILED` `UNKNOWN` 중 하나입니다.

| 상태 | 뜻 | 복구 |
|---|---|---|
| `FAILED` | 서버가 거부했거나 앱이 규칙에 따라 멈췄습니다(잔액 부족·로컬 검사 등). 원인이 기록에 있습니다 | 원인을 고치고 `resume` |
| `UNKNOWN` | 요청은 갔지만 처리됐는지 알 수 없습니다(응답 없음·5xx·오류 코드 없는 409·전송 중 취소) | `resume` — 서버 상태를 확인한 뒤 필요한 것만 다시 보냅니다 |

### 견적 게이트

주문 전에 견적을 뽑고, 충전금이 부족하면(`creditSufficient: false`) 주문을 보내지 않고 멈춥니다. 충전 뒤 `resume` 하면 견적부터 다시 합니다.

### 로컬 검사

서버에 보내기 전에 막는 것은 되돌리기 비싼 실수뿐입니다.

- **막습니다** — 없는 파일·PDF 가 아닌 파일, 판형에 없는 쪽수(서버가 준 판형 정보로 검사), 배송지 필수 누락·길이 초과·키 오타. 배송지를 여기서 막는 까닭은 서버가 배송지를 주문 단계에서야 검사하고 `resume` 은 배송지를 바꾸지 못하기 때문입니다
- **묻습니다** — 우편번호·전화번호 형식처럼 서버가 검증하지 않는 것은 경고하고 진행할지 묻습니다(기본값 아니오, `--yes` 면 경고만 보이고 진행)
- **서버에 맡깁니다** — PDF 쪽수·규격. 틀리면 업로드가 위반 항목을 전부 돌려주고, 고친 파일을 `resume --cover/--contents` 로 넣어 이어갈 수 있습니다

### 취소

- Ctrl+C 는 진행 중인 요청(업로드 포함)을 실제로 끊습니다. 끊긴 단계는 `UNKNOWN` 이 되어 `resume` 이 확인부터 합니다
- 입력을 기다리는 중이면 거기서 멈춥니다. 값을 묻던 중이면 작업을 만들지 않고, 주문 확인 같은 예/아니오 물음은 아니오로 끝냅니다
- 어느 쪽이든 종료 코드는 `130` 입니다

### 주문 이후

- 주문을 넣으면 서버 주문 상태가 `PDF_READY` 가 됩니다 — 인쇄 대기 자리입니다. Sandbox 는 여기서 더 가지 않습니다
- 위 단계 상태(`PENDING`…)는 **이 데모가 각 단계를 어디까지 했는지**, `PDF_READY` 는 **서버의 주문 상태**라 서로 다른 축입니다
- **흐름은 주문 생성에서 끝납니다.** 주문 상태 흐름·배송 추적·상태 변경 웹훅은 API 에 있지만 여기서 다루지 않습니다 — [주문 상태 흐름](https://api.sweetbook.com/docs/operations/order-status/), [Webhooks](https://api.sweetbook.com/docs/api/webhooks/) 을 보세요. 주문 취소는 [유지보수 스크립트](#유지보수-스크립트)에 있습니다

## 문제 해결

CLI 는 오류 아래에 다음에 할 일을 한 줄로 안내합니다. 이 데모에서 자주 만나는 경우는 다음과 같습니다.

| 상황 | 조치 |
|---|---|
| `SWEETBOOK_SANDBOX_API_KEY 가 비어 있습니다` 또는 `형식이 맞지 않습니다` | `.env` 에 포털에서 발급한 키를 앞뒤 공백 없이 넣습니다. 형식은 `SB` + 10자 + `.` + 32자 |
| `specs` 는 되는데 `run` 이 401 로 멈춘다 | 판형 조회는 인증 없이도 됩니다. `specs` 의 기본가가 `-` 로 나오면 키가 인증되지 않은 것이니, 포털에서 키를 확인하거나 재발급합니다 |
| `… 응답을 받지 못했습니다` (단계 `UNKNOWN`) | `resume <jobId>` — 서버에 반영됐는지 확인한 뒤 필요한 것만 다시 보냅니다 |
| 업로드가 PDF 규격 오류(400)로 멈췄다 | `specs --spec <UID> --pages <N>` 로 규격을 확인하고, 고친 파일로 `resume <jobId> --cover <pdf>`(또는 `--contents`) |
| 충전금이 부족해 견적에서 멈췄다 | [충전](#유지보수-스크립트) 뒤 `resume <jobId>` — 견적부터 다시 합니다 |

그 밖의 API 오류 코드(401·403·402 등)와 조치는 [오류 처리](https://api.sweetbook.com/docs/operations/error-handling/) 문서를 보세요. 서버가 돌려준 `errors`·`fieldErrors` 는 `status <jobId>` 기록에 있고, 응답 원본은 `--verbose` 로 펼칩니다.

## 프로젝트 구조

```
src/
  bookprint/   API 호출 모듈 — 클라이언트, 엔드포인트, 재시도, 응답 파싱. 다른 폴더에 의존하지 않음
  flow/        주문 흐름 — 단계 실행, 작업 상태, PDF·배송지 검사, 저장 인터페이스
  store/       JobStore 파일 구현. 자기 DB 구현으로 바꾸는 자리
  config/      환경변수 → 설정. process.env 를 읽는 유일한 곳
  cli/         명령, 프롬프트, 출력
tests/
  unit/        단위 테스트
  review/      실제로 났던 결함이 다시 생기지 않게 막는 회귀 테스트
  fixtures/    Sandbox 가 실제로 돌려준 응답 원본(계정 식별 필드와 시험 입력값만 바꿈) — 응답 파싱 테스트용
fixtures/      샘플 PDF(판형 2종, 24p)와 배송지 예시
scripts/       유지보수·검사 — 책 삭제, 주문 취소, sandbox 충전, `npm run check` 실행기
```

의존은 아래로만 흐릅니다 — 줄기는 `cli → flow → bookprint` 이고, `cli` 는 `config`·`store` 도 쓰며 `store` 는 `flow` 의 저장 인터페이스만, `config` 는 `bookprint` 의 타입만 봅니다. [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) 의 규칙을 `npm run check` 가 검사해, `bookprint/` 가 다른 폴더를 import 하거나 `flow/` 가 `store/`·`cli/`·`config/` 를 import 하면 실패합니다. `npm run build` 는 `dist/` 에 JS 와 타입 선언을 냅니다.

## 테스트

```bash
npm run check          # 타입 → 스타일 → 층 규칙 → 단위·회귀 테스트
npm test               # 테스트만
```

`check` 와 `test` 는 저장된 응답 원본으로 돌기 때문에 **네트워크도 API 키도 필요 없습니다** — 키 없이 클론해서 바로 돌릴 수 있습니다. 키가 필요한 것은 `cli` 와 아래 유지보수 스크립트입니다.

### 유지보수 스크립트

데모 흐름 밖의 정리·준비용입니다.

- Sandbox 에서 주문까지 실행했다면 취소해 충전금을 돌려받을 수 있습니다
- **시험을 마치면** 주문하지 않은 책은 `delete-book` 으로 지우세요(책 UID 는 `status <jobId>` 에 있습니다)
- 작업 파일 `jobs/<jobId>.json` 도 지우세요 — 책을 지워도 로컬 작업은 남아 `jobs` 목록에 계속 보이고, 배송지도 그대로 남습니다

```bash
node --env-file=.env --import tsx scripts/cancel-order.ts <orderUid>
node --env-file=.env --import tsx scripts/delete-book.ts <bookUid>
node --env-file=.env --import tsx scripts/charge-sandbox.ts            # 잔액만 보기
node --env-file=.env --import tsx scripts/charge-sandbox.ts 50000      # sandbox 충전
```

`charge-sandbox` 는 sandbox 잔액만 채웁니다 — 서버가 키 환경과 무관하게 언제나 test 잔액에 넣기 때문입니다. Live 충전은 `파트너 포털 > 충전금 > 충전` 의 결제뿐입니다.

## 기여

이슈와 PR 을 환영합니다. PR 을 보내기 전에 `npm run check` 가 통과하는지 확인해 주세요.

## 보안과 개인정보

**API 키.** 키를 이슈·PR·커밋에 붙이지 마세요. 이 데모는 키를 로그·작업 파일(`jobs/`)·오류 메시지 어디에도 싣지 않습니다 — 표시할 때는 앞 12자만 씁니다. 키가 노출됐으면 [파트너 포털](https://api.sweetbook.com/partner/) `> 설정 > API Key` 에서 즉시 재발급하세요. 옛 키는 그 자리에서 무효가 됩니다.

**배송지.** 작업 파일 `jobs/<jobId>.json` 에는 받는 사람의 이름·전화번호·주소가 **평문으로** 남습니다. 주문을 보냈다면 요청·응답 기록에도 들어가고, `status` 출력(특히 `--raw`·`--verbose`)에도 나옵니다.

- 이슈에 작업 파일이나 출력을 붙일 때는 배송지를 지우세요
- 작업 저장소를 DB 로 옮길 때는 이 값을 개인정보로 다루세요(접근 권한·보관 기간·삭제)

## 라이선스

[MIT](LICENSE) — Copyright (c) 2026 Sweetbook Inc.
