import { isAbsolute } from 'node:path';

/** CI uses its native Mongo test cache; local runs require an explicitly installed binary. */
export function checkpointTestEnvironment(env: NodeJS.ProcessEnv = process.env): {
  scratchRoot: string;
  binary: { version: string; systemBinary?: string };
} {
  const hosted = env.CI === 'true' && env.GITHUB_ACTIONS === 'true';
  const scratchRoot = env.UPLOAD_TEST_TMPDIR ?? (hosted ? env.RUNNER_TEMP : undefined);
  if (!scratchRoot || !isAbsolute(scratchRoot)) {
    throw new Error('An explicit absolute test scratch directory is required');
  }
  const systemBinary = env.MONGOMS_SYSTEM_BINARY;
  if (
    systemBinary ? !isAbsolute(systemBinary) || env.MONGOMS_RUNTIME_DOWNLOAD !== 'false' : !hosted
  ) {
    throw new Error('Local tests require an installed Mongo binary with downloads disabled');
  }
  return {
    scratchRoot,
    binary: { version: '7.0.43', ...(systemBinary ? { systemBinary } : {}) },
  };
}
