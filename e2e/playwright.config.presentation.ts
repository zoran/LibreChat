import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import mockConfig from './playwright.config.mock';

const servers = (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).filter((server) =>
  server.command.endsWith('start-server.js'),
);
if (servers.length !== 1) {
  throw new Error('Presentation requires the isolated single-server harness (E2E_REPLICAS=1).');
}
const baseURL = mockConfig.use?.baseURL;
const address = new URL(baseURL ?? '');
if (
  address.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) ||
  address.username ||
  address.password ||
  address.pathname !== '/' ||
  address.search ||
  address.hash
) {
  throw new Error(
    'Presentation requires an HTTP loopback origin without credentials or a subpath.',
  );
}
if (process.env.E2E_MODEL_FIXTURES === 'record') {
  throw new Error('Presentation does not record or contact model providers.');
}

const runtimePath = path.resolve(__dirname, 'presentation/.runtime/runtime-env.json');
process.env.E2E_RUNTIME_ENV_PATH = runtimePath;
const channel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

export default defineConfig({
  ...mockConfig,
  globalSetup: undefined,
  globalTeardown: undefined,
  testDir: 'presentation',
  testMatch: /(?:metadata|browser)\.spec\.ts$/,
  outputDir: 'presentation/.test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  globalTimeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [['line']],
  use: {
    ...mockConfig.use,
    storageState: { cookies: [], origins: [] },
    locale: 'en-US',
    serviceWorkers: 'block',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'presentation-desktop',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
    {
      name: 'presentation-mobile',
      testMatch: /browser\.spec\.ts$/,
      use: { ...devices['Pixel 5'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: servers.map((server) => ({
    ...server,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
    env: {
      ...server.env,
      CONFIG_PATH: path.resolve(__dirname, 'presentation/config.yaml'),
      HOST: address.hostname.replace(/^\[|\]$/g, ''),
      PORT: address.port || '80',
      DOMAIN_CLIENT: address.origin,
      DOMAIN_SERVER: address.origin,
      APP_TITLE: 'Example Workplace',
      CUSTOM_FOOTER: 'Example Workplace v1.2.3+example.1',
      AUTH_MODE: 'default',
      ALLOW_PASSKEY_LOGIN: 'false',
      ALLOW_PASSWORD_RESET: 'false',
      EMAIL_CODE_ENABLED: 'false',
      EMAIL_HOST: '',
      CORTEX_UPLOAD_MANAGEMENT_ENABLED: 'false',
      ENDPOINTS: 'openAI',
      OPENAI_MODELS: 'gpt-4o-mini',
      OPENAI_API_KEY: 'presentation-unused-local-fixture',
      OPENAI_REVERSE_PROXY: `${address.origin}/unused-provider`,
      ASSISTANTS_API_KEY: '',
      LIBRECHAT_TEST_RUN_HOOK: '',
      E2E_MODEL_FIXTURES: '',
      E2E_USE_MEMORY_MONGO: 'true',
      E2E_RUNTIME_ENV_PATH: runtimePath,
      MONGO_URI: 'mongodb://127.0.0.1:27017/presentation-e2e',
      E2E_REQUIRE_REDIS_STREAMS: 'false',
      USE_REDIS: 'false',
      USE_REDIS_STREAMS: 'false',
      USE_REDIS_CLUSTER: 'false',
      MONGOMS_RUNTIME_DOWNLOAD: 'false',
    },
  })),
});
