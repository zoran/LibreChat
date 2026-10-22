/** Standalone entry: acquire admitted configuration, then transfer to the existing service owner. */
const CONFIG_PATH = '/app/librechat.yaml';
const CONFIG_MAX_BYTES = 1048576;
let startupOriginal;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new Error('Housekeeping configuration unavailable');

function suppliedConfiguration(env) {
  const required = [
    'BUILD_COMMIT',
    'CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST',
    'CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID',
    'CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256',
    'UPLOAD_SECURITY_POLICY_SHA256',
    'EMAIL_CODE_ALLOWED_DOMAINS',
    'RETENTION_MAIL_TIMEZONE',
  ];
  if (
    required.some((key) => typeof env[key] !== 'string' || !env[key].length) ||
    !/^[a-f0-9]{40}$/.test(env.BUILD_COMMIT) ||
    !/^[a-f0-9]{64}$/.test(env.UPLOAD_SECURITY_POLICY_SHA256) ||
    (env.CONFIG_PATH !== undefined && env.CONFIG_PATH !== CONFIG_PATH)
  ) {
    throw unavailable();
  }
  const allowedDomains = env.EMAIL_CODE_ALLOWED_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (
    !allowedDomains.length ||
    !allowedDomains.every((domain) => /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(domain))
  ) {
    throw unavailable();
  }
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: env.RETENTION_MAIL_TIMEZONE }).format(0);
  } catch {
    throw unavailable();
  }
  return {
    expected: {
      sourceRevision: env.BUILD_COMMIT,
      imageDigest: env.CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST,
      namespaceUid: env.CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID,
      configurationSha256: env.CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256,
    },
    allowedDomains,
    timezone: env.RETENTION_MAIL_TIMEZONE,
  };
}

/** Read the same bounded local block as native activation, using its actual schema/default owner. */
async function readCheckpointConfiguration(signal, resolveCheckpointerConfig, failStartup) {
  const { open } = require('node:fs/promises');
  const { constants } = require('node:fs');
  const yaml = require('js-yaml');
  const { checkpointerSchema } = require('librechat-data-provider');
  let handle;
  let result;
  let failure;
  try {
    signal.throwIfAborted();
    handle = await open(CONFIG_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    signal.throwIfAborted();
    const stat = await handle.stat();
    signal.throwIfAborted();
    if (!stat.isFile() || stat.size < 1 || stat.size > CONFIG_MAX_BYTES) throw unavailable();
    const bytes = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > CONFIG_MAX_BYTES) throw unavailable();
    const config = yaml.load(bytes.subarray(0, length).toString('utf8'), {
      schema: yaml.JSON_SCHEMA,
    });
    if (!record(config)) throw unavailable();
    for (const value of [config.endpoints, config.endpoints?.agents]) {
      if (value !== undefined && !record(value)) throw unavailable();
    }
    const value = config.endpoints?.agents?.checkpointer;
    const block = checkpointerSchema
      .unwrap()
      .strict()
      .parse(value === undefined ? {} : value);
    if (Buffer.byteLength(JSON.stringify(block)) > 16384) throw unavailable();
    const resolved = resolveCheckpointerConfig(block);
    result = {
      type: resolved.type,
      ttl: resolved.ttlSeconds,
      checkpointCollectionName: resolved.checkpointCollectionName,
      checkpointWritesCollectionName: resolved.checkpointWritesCollectionName,
    };
  } catch {
    // Announce a known failure before joining a possibly unresolved original close operation.
    const aborted = signal.aborted;
    failStartup();
    failure = aborted ? signal.reason : unavailable();
  }
  if (handle) {
    try {
      await handle.close();
    } catch {
      failStartup();
      failure ??= unavailable();
    }
  }
  if (failure) throw failure;
  return result;
}

function begin(env) {
  // The logger's import-time behavior must be selected before importing either package entry.
  if (env.LOG_TO_FILE !== 'false' || process.env.LOG_TO_FILE !== 'false') throw unavailable();
  const path = require('node:path');
  require('module-alias')({ base: path.resolve(__dirname, '..') });
  const api = require('@librechat/api/housekeeping');
  api.setupGracefulShutdown(null, {
    timeoutMs: api.HOUSEKEEPING_POLICY.drainMs,
    deferHttpCloseUntilPreDrain: true,
  });
  const signal = api.getShutdownSignal();
  const failStartup = () => {
    void api.requestGracefulShutdown('startup_failure').catch(() => undefined);
  };
  let configurationOriginal;
  api.registerShutdownTask(
    'housekeeping original configuration',
    async () => {
      await configurationOriginal?.catch(() => undefined);
    },
    { phase: 'pre-drain' },
  );
  configurationOriginal = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    const supplied = suppliedConfiguration(env);
    const trustedFile = await api.loadManagedFileDeploymentConfiguration({
      expected: supplied.expected,
      signal,
      mode: 'required',
      onFailure: failStartup,
    });
    signal.throwIfAborted();
    if (!record(trustedFile)) throw unavailable();
    const checkpointConfig = await readCheckpointConfiguration(
      signal,
      api.resolveCheckpointerConfig,
      failStartup,
    );
    signal.throwIfAborted();
    const filePolicy = {
      securityPolicySha256: env.UPLOAD_SECURITY_POLICY_SHA256,
      extractionPolicySha256: trustedFile.extractionPolicySha256,
    };
    return {
      env,
      sourceId: env.BUILD_COMMIT,
      filePolicy,
      uploadPolicy: {
        ...filePolicy,
        retrievalInventoryAuthority: trustedFile.retrievalInventoryAuthority,
      },
      trustedFile,
      allowedDomains: supplied.allowedDomains,
      timezone: supplied.timezone,
      checkpointConfig,
    };
  });
  return configurationOriginal
    .then((configuration) => {
      signal.throwIfAborted();
      const { createHousekeepingService } = require('./services/Housekeeping');
      // The service owns the next acquisition. Never include its startup in configurationOriginal.
      return createHousekeepingService(configuration).start();
    })
    .catch((error) => {
      failStartup();
      throw error;
    });
}

/** One process invocation; importing this entry opens nothing and installs no signal handlers. */
function startHousekeeping(env = process.env) {
  if (!startupOriginal) {
    const selected = Object.freeze({ ...env });
    startupOriginal = Promise.resolve().then(() => begin(selected));
  }
  return startupOriginal;
}

module.exports = { startHousekeeping };

if (require.main === module) {
  void startHousekeeping().catch(() => {
    process.stderr.write('Housekeeping startup failed.\n');
    process.exitCode = 1;
  });
}
