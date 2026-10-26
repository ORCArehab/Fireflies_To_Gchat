import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests must never touch real credentials or Google APIs.
    env: { NODE_ENV: 'test' },
  },
});
