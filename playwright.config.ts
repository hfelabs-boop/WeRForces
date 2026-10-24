import { defineConfig, devices } from '@playwright/test';

// End-to-end tests drive the real GUI in Chromium against a built server
// (`npm run build` first; CI does). Two servers: an open one, and one with
// exercise-control and player keys for the fog-of-war tests.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node dist/server/cli.js --port 8130 --scenario calloway-crossroads', url: 'http://127.0.0.1:8130/api/v1', reuseExistingServer: false },
    {
      command: 'node dist/server/cli.js --port 8131 --scenario calloway-crossroads --api-key e2e-control --player blue:e2e-blue',
      url: 'http://127.0.0.1:8131/api/docs',
      reuseExistingServer: false,
    },
  ],
});
