import type { Environment } from '../bookprint/index.js';

export interface AppConfig {
  environment: Environment;
  apiKey: string;
  /** 표시용. 앞 12자 + **** */
  apiKeyMasked: string;
  jobsDir: string;
  /** 테스트 전용 URL 재정의. live 에서는 항상 undefined */
  baseUrlOverride: string | undefined;
}

export const KEY_FORMAT = /^SB[A-Za-z0-9]{10}\.[A-Za-z0-9_-]{32}$/;

const VAR_BY_ENV: Readonly<Record<Environment, string>> = {
  sandbox: 'SWEETBOOK_SANDBOX_API_KEY',
  live: 'SWEETBOOK_LIVE_API_KEY',
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function maskKey(key: string): string {
  return key.length >= 12 ? `${key.slice(0, 12)}.****` : '****';
}

export function loadConfig(
  environment: Environment,
  source: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const varName = VAR_BY_ENV[environment];
  const apiKey = (source[varName] ?? '').trim();
  if (apiKey === '') {
    throw new ConfigError(
      `${varName} 가 비어 있습니다. .env 에 ${environment} 키를 넣으세요. ` +
        `발급: https://api.sweetbook.com/partner/ > 설정 > API Key` +
        `${environment === 'live' ? ' (live 는 스위트북과 사업 협의 후 열립니다).' : ' > Sandbox.'}`,
    );
  }
  if (!KEY_FORMAT.test(apiKey)) {
    throw new ConfigError(
      `${varName} 형식이 맞지 않습니다 (${maskKey(apiKey)}). 기대 형식: SB + 10자 + '.' + 32자. ` +
        '포털에서 복사할 때 앞뒤 공백이나 줄바꿈이 섞이지 않았는지 확인하세요.',
    );
  }
  const override =
    environment === 'sandbox' ? (source.BOOKPRINT_BASE_URL_OVERRIDE ?? '').trim() : '';
  return {
    environment,
    apiKey,
    apiKeyMasked: maskKey(apiKey),
    jobsDir: (source.BOOKPRINT_JOBS_DIR ?? './jobs').trim() || './jobs',
    baseUrlOverride: override === '' ? undefined : override,
  };
}

export function parseEnvironment(value: string | undefined): Environment {
  if (value === undefined || value === '' || value === 'sandbox') return 'sandbox';
  if (value === 'live') return 'live';
  throw new ConfigError(`--env 는 sandbox 또는 live 여야 합니다. 받은 값: ${value}`);
}
