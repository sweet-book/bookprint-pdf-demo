import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JobState, type JobStore, type JobSummary, nextStep } from '../flow/store.js';

/** JobStore 파일 구현 — jobs/<id>.json 하나에 작업 하나 */
export class FileJobStore implements JobStore {
  constructor(private readonly dir: string) {}

  async get(id: string): Promise<JobState | null> {
    try {
      const text = await readFile(this.pathOf(id), 'utf8');
      return JSON.parse(text) as JobState;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async save(job: JobState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const final = this.pathOf(job.id);
    const tmp = `${final}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    await renameOver(tmp, final);
  }

  async list(): Promise<JobSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const jobs = await Promise.all(
      names
        .filter((n) => n.endsWith('.json') && /^[A-Za-z0-9_-]+\.json$/.test(n))
        .map((n) => this.get(n.slice(0, -'.json'.length)).catch(() => null)),
    );
    const out: JobSummary[] = [];
    for (const job of jobs) {
      if (!job || typeof job !== 'object' || !job.steps || typeof job.id !== 'string') continue;
      out.push({
        id: job.id,
        env: job.env,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        bookUid: job.bookUid,
        orderUid: job.orderUid,
        next: nextStep(job) ?? 'done',
      });
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private pathOf(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid job id: ${id}`);
    return join(this.dir, `${id}.json`);
  }
}

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null;
      const busy = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!busy || attempt >= 20) {
        await rm(from, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
