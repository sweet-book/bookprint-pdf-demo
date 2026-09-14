import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { TEST_KEY } from '../helpers.js';

test('서버 오류 본문이 키를 되비춰도 CLI 는 키 전체를 출력하지 않는다', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        message: `rejected: Authorization: Bearer ${TEST_KEY}`,
        data: null,
        errorCode: 'ERR_UNAUTHORIZED',
        errors: [`bad token ${TEST_KEY}`],
        fieldErrors: [],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const out = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
      (resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'specs'], {
          env: {
            ...process.env,
            SWEETBOOK_SANDBOX_API_KEY: TEST_KEY,
            BOOKPRINT_BASE_URL_OVERRIDE: `http://127.0.0.1:${port}/v1`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (d) => {
          stderr += String(d);
        });
        child.stdout.on('data', (d) => {
          stdout += String(d);
        });
        child.on('close', (code) => resolve({ code, stderr, stdout }));
      },
    );
    assert.notEqual(out.code, 0, 'specs 는 401 로 실패해야 한다');
    const all = out.stderr + out.stdout;
    assert.ok(!all.includes(TEST_KEY), `키 전체가 출력됐다:\n${all}`);
    assert.ok(all.includes(TEST_KEY.slice(0, 12)), '마스킹된 앞자리는 보여야 한다 (어느 키인지)');
  } finally {
    server.close();
  }
});
