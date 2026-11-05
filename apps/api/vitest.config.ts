import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

/** Ordem fixa (alfabética): os arquivos compartilham o mesmo banco, então a ordem não pode variar entre execuções. */
class StableSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    sequence: { sequencer: StableSequencer },
    globalSetup: ['./test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://eskimo:eskimo_dev@localhost:5432/eskimo_test',
      APP_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      APP_ORIGIN: 'http://localhost:5173',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      LOGIN_RATE_LIMIT: '1000',
    },
  },
});
