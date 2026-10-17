import { checkpointTestEnvironment } from './__tests__/helpers/mongo';

const local = {
  UPLOAD_TEST_TMPDIR: '/owned/test-scratch',
  MONGOMS_SYSTEM_BINARY: '/owned/tools/mongod',
  MONGOMS_RUNTIME_DOWNLOAD: 'false',
};

it('preserves the explicit offline local test configuration', () => {
  expect(checkpointTestEnvironment(local)).toEqual({
    scratchRoot: '/owned/test-scratch',
    binary: { version: '7.0.43', systemBinary: '/owned/tools/mongod' },
  });
});

it('supports the existing GitHub Actions environment without a developer host path', () => {
  expect(
    checkpointTestEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/runner/temp' }),
  ).toEqual({ scratchRoot: '/runner/temp', binary: { version: '7.0.43' } });
});

it.each([
  {},
  { ...local, UPLOAD_TEST_TMPDIR: 'relative' },
  { ...local, MONGOMS_SYSTEM_BINARY: 'relative' },
  { ...local, MONGOMS_RUNTIME_DOWNLOAD: 'true' },
  { CI: 'true', UPLOAD_TEST_TMPDIR: '/owned/test-scratch' },
  { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_TEMP: 'relative' },
])('rejects an unowned or implicitly downloading local test configuration: %j', (env) => {
  expect(() => checkpointTestEnvironment(env)).toThrow();
});
