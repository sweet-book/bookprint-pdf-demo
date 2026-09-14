import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newJob } from '../../src/flow/index.js';
import { FileJobStore } from '../../src/store/fileStore.js';

test('같은 작업을 동시에 저장해도 실패하지 않고 온전한 파일 하나만 남는다 — 두 터미널에서 같은 작업을 resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookprint-store-'));
  try {
    const store = new FileJobStore(dir);
    const job = newJob(
      { bookSpecUid: 'SQUAREBOOK_HC', pageCount: 24, title: 't' },
      {
        env: 'sandbox',
        now: () => new Date('2026-09-11T00:00:00Z'),
        uuid: () => 'u',
        id: 'j_concurrent',
      },
    );
    const versions = Array.from({ length: 20 }, (_, i) => ({
      ...job,
      updatedAt: `2026-09-11T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));

    await Promise.all(versions.map((v) => store.save(v)));

    const saved = await store.get(job.id);
    assert.ok(saved, '작업 파일이 남아 있다');
    assert.ok(
      versions.some((v) => v.updatedAt === saved.updatedAt),
      '저장한 판 가운데 하나와 같다 — 두 판이 섞이지 않았다',
    );
    assert.deepEqual(await readdir(dir), ['j_concurrent.json'], '임시 파일이 남지 않는다');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
