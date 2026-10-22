import { defineConfig, devices } from '@playwright/test';
// TEST_PORT moves the suite off the default port when that one is taken; the fault server (tests/faults.mjs), a second origin, takes the next.
const port = Number(process.env.TEST_PORT || 4174);
// Both engines run the whole suite: the owner's panel, Safari and every browser on iPhone use WebKit, where a leaf
// built from CSS 3D strips showed a hairline at every joint that Chromium rendered cleanly.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: 'seams.spec.js' },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    { command: 'node scripts/serve.mjs', port, env: { PORT: String(port) }, reuseExistingServer: false },
    { command: 'node tests/faults.mjs', port: port + 1, env: { PORT: String(port + 1) }, reuseExistingServer: false },
  ],
});
