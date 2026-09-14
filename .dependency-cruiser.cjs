/** 층 규칙 — cli/ → flow/ → bookprint/ 로 아래로만 의존한다. store/ 는 flow/store.ts 만 본다 */
module.exports = {
  forbidden: [
    {
      name: 'bookprint-imports-nothing',
      comment: '호출 모듈은 어떤 상위 층도 모른다',
      severity: 'error',
      from: { path: '^src/bookprint' },
      to: { path: '^src/(flow|store|cli|config)' },
    },
    {
      name: 'flow-imports-only-bookprint',
      comment: '흐름은 호출 모듈만 안다. 저장 구현·껍데기·환경변수를 모른다',
      severity: 'error',
      from: { path: '^src/flow' },
      to: { path: '^src/(store|cli|config)' },
    },
    {
      name: 'store-imports-only-flow-interface',
      comment: '저장 구현은 flow/store.ts 인터페이스만 본다',
      severity: 'error',
      from: { path: '^src/store' },
      to: { path: '^src/(cli|config|bookprint)|^src/flow/(?!store\\.ts$)' },
    },
    {
      name: 'no-process-env-outside-config',
      comment: '환경변수는 config/ 에서만 읽는다. 호출 모듈은 키를 인자로 받는다',
      severity: 'error',
      from: { path: '^src/(bookprint|flow|store)' },
      to: { path: '^node:process$|^process$' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
