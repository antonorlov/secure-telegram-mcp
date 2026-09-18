import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      /**
       * The e2e suites spawn processes and drive real daemon timing; inside the parallel sweep
       * a 2-core CI runner starves them past their deadlines. They run isolated instead:
       * `npm run test:e2e` (its own CI step, after build).
       */
      ...(process.env['INCLUDE_E2E'] === '1' ? [] : ['tests/e2e/**']),
    ],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts'],
    },
  },
});
