import { defineConfig } from 'vitest/config';

// Contracts hold the pure rules (money math, state tables): every line and branch is tested
// (ADR 0011). A gap fails `pnpm test`.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { 100: true },
    },
  },
});
