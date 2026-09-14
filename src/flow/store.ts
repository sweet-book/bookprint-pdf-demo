import { type JobState, nextStep } from './job.js';

export type { JobState };
export { nextStep };

/** 작업 저장 인터페이스. 파일 구현은 store/fileStore.ts — DB 에 저장하려면 이것을 구현한다 */
export interface JobStore {
  get(id: string): Promise<JobState | null>;
  save(job: JobState): Promise<void>;
  list(): Promise<JobSummary[]>;
}

export interface JobSummary {
  id: string;
  env: JobState['env'];
  createdAt: string;
  updatedAt: string;
  bookUid: string | null;
  orderUid: string | null;
  /** 다음 단계 또는 'done' */
  next: string;
}
