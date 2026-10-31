/** Standalone entry: acquire admitted configuration, then transfer to the existing service owner. */
const CONFIG_PATH = '/app/librechat.yaml';
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
    const localConfiguration = await api.readHousekeepingLocalConfiguration({
      signal,
      resolveCheckpointerConfig: api.resolveCheckpointerConfig,
      onFailure: failStartup,
    });
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
      ...localConfiguration,
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
