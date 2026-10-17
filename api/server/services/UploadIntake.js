const jwt = require('jsonwebtoken');
const { createHash, randomBytes } = require('node:crypto');
const { isAbsolute } = require('node:path');
const { readFile } = require('node:fs/promises');
const { createEmailCodeUploadGrant, UploadManagementError } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');

/** Only the native App authenticates users. Intake receives a one-operation capability. */
function createUploadTicketIssuer({ repository, identityRepository, management }) {
  return async (request, principal, id) => {
    const authorization = request.headers.authorization;
    if (
      principal.authentication !== 'verified-email' ||
      typeof authorization !== 'string' ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)
    )
      throw new UploadManagementError('unauthorized');
    let grant;
    try {
      const payload = jwt.verify(authorization.slice(7), process.env.JWT_SECRET, {
        algorithms: ['HS256'],
      });
      grant = await runAsSystem(() => createEmailCodeUploadGrant(payload, identityRepository));
    } catch {
      throw new UploadManagementError('unauthorized');
    }
    if (
      !grant ||
      grant.principal.tenantId !== principal.tenantId ||
      grant.principal.userId !== principal.userId
    )
      throw new UploadManagementError('unauthorized');
    const operation = await management.get(principal, id);
    if (operation.state !== 'waiting') throw new UploadManagementError('not_ready');
    const capability = randomBytes(32).toString('base64url');
    await repository.issueIntake(
      principal,
      id,
      createHash('sha256').update(capability).digest('hex'),
      grant,
      Date.now(),
    );
    return { version: 1, operationId: id, capability, expiresAt: grant.expiresAt };
  };
}

/** Provisioned service roles and hosts. Native Intake composition owns each process identity. */
async function managedIntakeControlConfig() {
  const paths = ['CA', 'CERT', 'KEY', 'PEERS'].map(
    (name) => process.env[`UPLOAD_INTAKE_${name}_FILE`],
  );
  if (paths.some((value) => !value || !isAbsolute(value)))
    throw new Error('Upload intake configuration unavailable');
  try {
    const [ca, cert, key, peers] = await Promise.all(
      paths.map(async (file) => {
        const value = await readFile(file);
        if (!value.length || value.length > 65536) throw new Error();
        return value;
      }),
    );
    return {
      tls: { ca, cert, key },
      peers: JSON.parse(peers.toString('utf8')),
      host: '0.0.0.0',
      port: 8444,
    };
  } catch {
    throw new Error('Upload intake configuration unavailable');
  }
}

module.exports = { createUploadTicketIssuer, managedIntakeControlConfig };
