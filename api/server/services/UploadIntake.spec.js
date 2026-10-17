const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createEmailCodeUploadGrant: jest.fn(),
}));
const { createEmailCodeUploadGrant } = require('@librechat/api');
const { createUploadTicketIssuer, managedIntakeControlConfig } = require('./UploadIntake');

describe('native App ticket composition', () => {
  const principal = {
    authentication: 'verified-email',
    tenantId: 'tenant',
    userId: 'a'.repeat(24),
  };
  let environment;
  let repository;
  let management;
  let identityRepository;
  let issue;
  let grant;
  const request = (algorithm = 'HS256') => ({
    headers: {
      authorization: `Bearer ${jwt.sign({ id: principal.userId }, process.env.JWT_SECRET, { algorithm, expiresIn: 60 })}`,
    },
    body: { tenantId: 'forged', filename: 'untrusted' },
  });
  beforeEach(() => {
    environment = { ...process.env };
    process.env.JWT_SECRET = 'synthetic-ticket-key';
    jest.clearAllMocks();
    grant = {
      version: 1,
      principal,
      sessionId: 'b'.repeat(24),
      authVersion: 1,
      policyVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    createEmailCodeUploadGrant.mockResolvedValue(grant);
    repository = { issueIntake: jest.fn(async () => undefined) };
    management = { get: jest.fn(async () => ({ id: 'operation', state: 'waiting' })) };
    identityRepository = {};
    issue = createUploadTicketIssuer({ repository, identityRepository, management });
  });
  afterEach(() => {
    process.env = environment;
  });

  it('verifies the JWT and retains only a capability hash with the native private grant', async () => {
    const result = await issue(request(), principal, 'operation');
    expect(result).toEqual({
      version: 1,
      operationId: 'operation',
      capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: grant.expiresAt,
    });
    expect(Buffer.from(result.capability, 'base64url')).toHaveLength(32);
    expect(createEmailCodeUploadGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: principal.userId }),
      identityRepository,
    );
    expect(repository.issueIntake).toHaveBeenCalledWith(
      principal,
      'operation',
      createHash('sha256').update(result.capability).digest('hex'),
      grant,
      expect.any(Number),
    );
    expect(JSON.stringify(repository.issueIntake.mock.calls)).not.toContain(result.capability);
    expect(JSON.stringify(result)).not.toContain(grant.sessionId);
    expect(management.get).toHaveBeenCalledWith(principal, 'operation');
  });

  it('rejects a different signing algorithm before native identity or storage access', async () => {
    await expect(issue(request('HS384'), principal, 'operation')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(createEmailCodeUploadGrant).not.toHaveBeenCalled();
    expect(repository.issueIntake).not.toHaveBeenCalled();
  });

  it.each(['missing', 'owner', 'guest'])('rejects a %s native identity binding', async (kind) => {
    if (kind === 'missing') createEmailCodeUploadGrant.mockResolvedValue(null);
    if (kind === 'owner')
      createEmailCodeUploadGrant.mockResolvedValue({
        ...grant,
        principal: { ...principal, userId: 'c'.repeat(24) },
      });
    await expect(
      issue(
        request(),
        kind === 'guest' ? { ...principal, authentication: 'guest' } : principal,
        'operation',
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(repository.issueIntake).not.toHaveBeenCalled();
  });

  it('cannot issue a replacement after transfer has started', async () => {
    management.get.mockResolvedValue({ id: 'operation', state: 'transferring' });
    await expect(issue(request(), principal, 'operation')).rejects.toMatchObject({
      code: 'not_ready',
    });
    expect(repository.issueIntake).not.toHaveBeenCalled();
  });

  it('fails closed without operator-owned peer and TLS configuration', async () => {
    delete process.env.UPLOAD_INTAKE_PEERS_FILE;
    await expect(managedIntakeControlConfig()).rejects.toThrow(
      'Upload intake configuration unavailable',
    );
    expect(require('node:fs/promises').readFile).not.toHaveBeenCalled();
  });
});
