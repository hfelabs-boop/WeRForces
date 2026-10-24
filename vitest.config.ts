import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Simulation runs take a few seconds locally and more on shared CI runners.
    testTimeout: 30_000,
  },
});
