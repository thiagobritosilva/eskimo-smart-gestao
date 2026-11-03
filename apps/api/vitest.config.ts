import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
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
