/** LibreChat configuration adapter; storage policy and local safety remain component-owned. */
const { readFile } = require('node:fs/promises');
const { createUploadPlatformRuntime, parseUploadBackendBinding } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');

async function publicJson(filename) {
  const bytes = await readFile(filename);
  if (bytes.length > 65536) throw new Error('Invalid upload platform configuration');
  return JSON.parse(bytes.toString('utf8'));
}

async function createUploadPlatform({ repository, worker, stagingRoot }) {
  let expectedHosts;
  let collectors;
  try {
    expectedHosts = JSON.parse(process.env.CORTEX_UPLOAD_EXPECTED_HOSTS || 'null');
    collectors = process.env.CORTEX_UPLOAD_RESOURCE_COLLECTORS
      ? JSON.parse(process.env.CORTEX_UPLOAD_RESOURCE_COLLECTORS)
      : undefined;
  } catch {
    throw new Error('Invalid upload platform configuration');
  }
  if (
    !Array.isArray(expectedHosts) ||
    expectedHosts.length !== 4 ||
    expectedHosts.some((host) => typeof host !== 'string')
  )
    throw new Error('Invalid upload platform hosts');
  let binding;
  try {
    binding = parseUploadBackendBinding(
      await publicJson(
        process.env.CORTEX_UPLOAD_BACKEND_CONFIG || '/etc/cortex-upload-safety/backend.json',
      ),
      expectedHosts,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Invalid upload safety binding');
  }
  let tls;
  if (collectors !== undefined) {
    if (!Array.isArray(collectors) || collectors.length !== 2)
      throw new Error('Invalid upload collectors');
    const [ca, cert, key] = await Promise.all(
      ['ca.crt', 'client.crt', 'client.key'].map((name) =>
        readFile(`/etc/cortex-upload-resources/${name}`),
      ),
    );
    tls = { ca, cert, key };
  }
  const backendCa = binding ? await readFile('/var/run/cortex-upload-safety/ca.crt') : undefined;
  return createUploadPlatformRuntime({
    repository: {
      localReservations: (owner, now) =>
        runAsSystem(() => repository.localReservations(owner, now)),
    },
    worker,
    stagingRoot,
    parserSocketPath: '/var/run/cortex-upload-parser/parser.sock',
    expectedHosts,
    collectors,
    tls,
    backendBinding: binding,
    backendCa,
    cgroupDirectory: '/sys/fs/cgroup',
  });
}

module.exports = { createUploadPlatform };
