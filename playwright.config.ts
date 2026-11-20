import { defineConfig } from '@playwright/test';
// @ts-expect-error plain .mjs helper shared with tools/shots.mjs
import { GL_FLAG_SETS } from './tools/browser.mjs';

const port = Number(process.env.MYRME_PORT ?? 5199);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 960, height: 540 },
    launchOptions: { args: GL_FLAG_SETS[0].args },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
