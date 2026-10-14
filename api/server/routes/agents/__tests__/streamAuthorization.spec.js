const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');

const mockValidateEmailCodeBearer = jest.fn();
const mockValidateBrowserBearer = jest.fn();
const mockRepository = {};
jest.mock('@librechat/api', () => ({
  validateEmailCodeBearer: (...args) => mockValidateEmailCodeBearer(...args),
  validateBrowserBearer: (...args) => mockValidateBrowserBearer(...args),
}));
jest.mock('@librechat/data-schemas', () => ({ runAsSystem: (action) => action() }));
jest.mock('~/models', () => mockRepository);

const {
  createStreamAuthorizationController,
  STREAM_AUTHORIZATION_LIMITS,
} = require('../streamAuthorization');

describe('bounded current-grant chat disclosure', () => {
  let previous;
  let identity;
  let opened;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-13T23:30:00Z') });
    jest.clearAllMocks();
    previous = { ...process.env };
    process.env.JWT_SECRET = 'stream-authorization-fixture-only';
    opened = [];
    identity = {
      user: { id: '222222222222222222222222', tenantId: 'cortex-bwi' },
      grant: {
        sessionId: '111111111111111111111111',
        userId: '222222222222222222222222',
        tenantId: 'cortex-bwi',
        authVersion: 0,
        policyVersion: 1,
        refreshGeneration: 0,
        createdAt: Date.now() - 1000,
        absoluteExpiresAt: Date.now() + 3600000,
        idleExpiresAt: Date.now() + 600000,
      },
    };
    mockValidateEmailCodeBearer.mockResolvedValue(identity);
  });
  afterEach(() => {
    for (const output of opened) output.close();
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env = previous;
  });

  function fixture({
    controller = createStreamAuthorizationController(),
    userId,
    token,
    write,
    guest = false,
  } = {}) {
    const grant = { ...identity.grant, ...(userId && { userId }) };
    const claims = {
      id: grant.userId,
      sessionId: grant.sessionId,
      tenantId: grant.tenantId,
      authMethod: 'email_code',
      tokenUse: 'access',
      authVersion: grant.authVersion,
      policyVersion: grant.policyVersion,
      generation: grant.refreshGeneration,
      issuedAtMs: Date.now(),
    };
    const req = Object.assign(new EventEmitter(), {
      headers: {
        authorization: `Bearer ${
          token ?? jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 300 })
        }`,
      },
      user: { id: grant.userId, tenantId: grant.tenantId },
      authenticationClass: 'verified-email',
      emailCodeGrant: grant,
    });
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      end: jest.fn(function () {
        this.writableEnded = true;
        this.emit('finish');
      }),
      destroy: jest.fn(function () {
        this.destroyed = true;
        this.emit('close');
      }),
    });
    if (guest) {
      req.authenticationClass = 'guest';
      delete req.emailCodeGrant;
      req.user = { id: grant.userId, provider: 'browser' };
      req.browserGrant = { userId: grant.userId, sessionId: grant.sessionId, tenantId: null };
      req.headers.authorization = `Bearer ${jwt.sign({ id: grant.userId, provider: 'browser' }, process.env.JWT_SECRET, { expiresIn: 300 })}`;
      mockValidateBrowserBearer.mockResolvedValue({ user: req.user, grant: req.browserGrant });
    }
    const writer = jest.fn(write ?? (() => true));
    const onClose = jest.fn();
    const output = controller({ req, res, write: writer, onClose });
    opened.push(output);
    return { output, req, res, writer, onClose };
  }

  it('rechecks the same guest session during document disclosure and rejects revoked reconnects', async () => {
    const f = fixture({ guest: true });
    expect(f.output.write({ text: 'private document answer' })).toBe(true);
    await jest.advanceTimersByTimeAsync(250);
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(mockValidateBrowserBearer).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'browser' }),
      f.req,
      mockRepository,
    );
    expect(mockValidateEmailCodeBearer).not.toHaveBeenCalled();
    mockValidateBrowserBearer.mockResolvedValue(null);
    f.output.write({ text: 'must not disclose' });
    await jest.advanceTimersByTimeAsync(250);
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(f.output.closed).toBe(true);
    const reconnect = fixture({ guest: true });
    mockValidateBrowserBearer.mockResolvedValue(null);
    reconnect.output.write({ text: 'replay' });
    await jest.advanceTimersByTimeAsync(250);
    expect(reconnect.writer).not.toHaveBeenCalled();
    expect(reconnect.output.closed).toBe(true);
  });

  it('authorizes one bounded batch rather than each token and ends only after its final frame', async () => {
    const f = fixture();
    for (let n = 0; n < 100; n++) expect(f.output.write({ text: String(n) })).toBe(true);
    f.output.finish({ final: true });
    expect(f.res.end).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(250);
    expect(mockValidateEmailCodeBearer).toHaveBeenCalledTimes(1);
    expect(mockValidateEmailCodeBearer).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenUse: 'access',
        sessionId: identity.grant.sessionId,
      }),
      mockRepository,
    );
    expect(f.writer).toHaveBeenCalledTimes(101);
    expect(f.writer.mock.calls[0][0]).toContain('"text":"0"');
    expect(f.writer.mock.calls[100][0]).toContain('"final":true');
    expect(f.res.end).toHaveBeenCalledTimes(1);
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('requires another current read for frames arriving during an authorization flight', async () => {
    let release;
    mockValidateEmailCodeBearer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture();
    f.output.write({ text: 'before-read' });
    await jest.advanceTimersByTimeAsync(250);
    f.output.write({ text: 'after-revocation' });
    mockValidateEmailCodeBearer.mockResolvedValue(null);
    release(identity);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.writer).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(250);
    expect(mockValidateEmailCodeBearer).toHaveBeenCalledTimes(2);
    expect(f.writer.mock.calls[0][0]).toContain('before-read');
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['revoked', 'unavailable', 'tenant', 'session', 'user'])(
    'closes without content on %s authority',
    async (kind) => {
      const f = fixture();
      if (kind === 'revoked') mockValidateEmailCodeBearer.mockResolvedValue(null);
      else if (kind === 'unavailable')
        mockValidateEmailCodeBearer.mockRejectedValue(new Error('private store detail'));
      else {
        const changed = { ...identity, grant: { ...identity.grant } };
        changed.grant[{ tenant: 'tenantId', session: 'sessionId', user: 'userId' }[kind]] = 'other';
        mockValidateEmailCodeBearer.mockResolvedValue(changed);
      }
      f.output.write({ text: 'private' });
      await jest.advanceTimersByTimeAsync(250);
      expect(f.writer).not.toHaveBeenCalled();
      expect(f.res.destroy).toHaveBeenCalledTimes(1);
      expect(f.onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('verifies the signature and expiry again rather than treating the stored grant as a bearer', async () => {
    const invalid = fixture({ token: jwt.sign({ id: identity.grant.userId }, 'another-key') });
    invalid.output.write({ text: 'private' });
    await jest.advanceTimersByTimeAsync(250);
    expect(invalid.writer).not.toHaveBeenCalled();
    expect(mockValidateEmailCodeBearer).not.toHaveBeenCalled();
    const expired = fixture({
      token: jwt.sign({ id: identity.grant.userId }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: -1,
      }),
    });
    expired.output.write({ text: 'private' });
    await jest.advanceTimersByTimeAsync(250);
    expect(expired.writer).not.toHaveBeenCalled();
    expect(mockValidateEmailCodeBearer).not.toHaveBeenCalled();
  });

  it('revalidates idle attachments at fifteen seconds without disclosing or extending a session', async () => {
    const f = fixture();
    mockValidateEmailCodeBearer.mockResolvedValue(null);
    await jest.advanceTimersByTimeAsync(15000);
    expect(mockValidateEmailCodeBearer).toHaveBeenCalledTimes(1);
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled auth and never publishes its late success', async () => {
    let release;
    mockValidateEmailCodeBearer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture();
    f.output.write({ text: 'private' });
    await jest.advanceTimersByTimeAsync(5250);
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
    release(identity);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.onClose).toHaveBeenCalledTimes(1);
  });

  it('reauthorizes the remainder after socket backpressure and keeps final ordering', async () => {
    const f = fixture({ write: () => false });
    f.output.write({ text: 'already-handed-to-socket' });
    f.output.finish({ final: true, text: 'must-not-follow-revocation' });
    await jest.advanceTimersByTimeAsync(250);
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(f.res.end).not.toHaveBeenCalled();
    mockValidateEmailCodeBearer.mockResolvedValue(null);
    f.res.emit('drain');
    await jest.advanceTimersByTimeAsync(250);
    expect(f.writer).toHaveBeenCalledTimes(1);
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a socket that does not drain and releases its local charges exactly once', async () => {
    const controller = createStreamAuthorizationController({
      ...STREAM_AUTHORIZATION_LIMITS,
      connections: 1,
    });
    const f = fixture({ controller, write: () => false });
    f.output.write({ text: 'slow' });
    await jest.advanceTimersByTimeAsync(5250);
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
    f.output.close();
    f.res.emit('drain');
    expect(f.onClose).toHaveBeenCalledTimes(1);
    const next = fixture({ controller });
    expect(next.res.destroy).not.toHaveBeenCalled();
  });

  it('keeps a finishing response charged until finish and destroys a stalled end', async () => {
    const controller = createStreamAuthorizationController({
      ...STREAM_AUTHORIZATION_LIMITS,
      connections: 1,
    });
    const f = fixture({ controller });
    f.res.end.mockImplementation(function () {
      this.writableEnded = true;
    });
    f.output.finish({ final: true });
    await jest.advanceTimersByTimeAsync(250);
    expect(f.res.end).toHaveBeenCalledTimes(1);
    expect(f.onClose).not.toHaveBeenCalled();
    expect(fixture({ controller }).res.destroy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(fixture({ controller }).res.destroy).not.toHaveBeenCalled();
  });

  it('withholds a batch when its signed access token expires during the current read', async () => {
    let release;
    mockValidateEmailCodeBearer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const token = jwt.sign({ id: identity.grant.userId }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: 1,
    });
    const f = fixture({ token });
    f.output.write({ text: 'private' });
    await jest.advanceTimersByTimeAsync(1250);
    release(identity);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.writer).not.toHaveBeenCalled();
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
  });

  it('enforces process and principal connection caps without granting authority to shared IPs', () => {
    const controller = createStreamAuthorizationController({
      ...STREAM_AUTHORIZATION_LIMITS,
      connections: 3,
      perOwner: 2,
    });
    const a = fixture({ controller });
    fixture({ controller });
    const denied = fixture({ controller });
    expect(denied.res.destroy).toHaveBeenCalledTimes(1);
    fixture({ controller, userId: '333333333333333333333333' });
    const full = fixture({ controller, userId: '444444444444444444444444' });
    expect(full.res.destroy).toHaveBeenCalledTimes(1);
    a.output.close();
    expect(fixture({ controller }).res.destroy).not.toHaveBeenCalled();
  });

  it('retains a closed but unsettled authorization slot instead of accumulating new promises', async () => {
    const controller = createStreamAuthorizationController({
      ...STREAM_AUTHORIZATION_LIMITS,
      authFlights: 1,
    });
    let release;
    mockValidateEmailCodeBearer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = fixture({ controller });
    first.output.write({ text: 'first' });
    await jest.advanceTimersByTimeAsync(250);
    first.output.close();
    const denied = fixture({ controller });
    denied.output.write({ text: 'second' });
    await jest.advanceTimersByTimeAsync(250);
    expect(denied.res.destroy).toHaveBeenCalledTimes(1);
    expect(mockValidateEmailCodeBearer).toHaveBeenCalledTimes(1);
    release(identity);
    await jest.advanceTimersByTimeAsync(0);
    const next = fixture({ controller });
    next.output.finish({ final: true });
    await jest.advanceTimersByTimeAsync(250);
    expect(next.res.writableEnded).toBe(true);
  });

  it('caps queued event counts before expanding the queue', () => {
    const f = fixture({
      controller: createStreamAuthorizationController({
        ...STREAM_AUTHORIZATION_LIMITS,
        frames: 2,
      }),
    });
    expect(f.output.write({ text: 'one' })).toBe(true);
    expect(f.output.write({ text: 'two' })).toBe(true);
    expect(f.output.write({ text: 'three' })).toBe(false);
    expect(f.res.destroy).toHaveBeenCalledTimes(1);
    expect(f.writer).not.toHaveBeenCalled();
  });

  it('caps UTF-8 frame and aggregate pending bytes and frees budget on closure', () => {
    const limits = {
      ...STREAM_AUTHORIZATION_LIMITS,
      frameBytes: 200,
      connectionBytes: 250,
      processBytes: 250,
    };
    const controller = createStreamAuthorizationController(limits);
    const first = fixture({ controller });
    expect(first.output.write({ text: 'é'.repeat(60) })).toBe(true);
    const second = fixture({ controller });
    expect(second.output.write({ text: 'é'.repeat(60) })).toBe(false);
    expect(second.res.destroy).toHaveBeenCalledTimes(1);
    first.output.close();
    const next = fixture({ controller });
    expect(next.output.write({ text: 'é'.repeat(60) })).toBe(true);
    expect(next.output.write({ text: 'x'.repeat(201) })).toBe(false);
    expect(next.res.destroy).toHaveBeenCalledTimes(1);
  });

  it('contains circular/throwing JSON serialization and closes without disclosure', () => {
    for (const value of [
      (() => {
        const x = {};
        x.self = x;
        return x;
      })(),
      {
        toJSON() {
          throw new Error('private serialization detail');
        },
      },
    ]) {
      const f = fixture();
      expect(() => f.output.write(value)).not.toThrow();
      expect(f.res.destroy).toHaveBeenCalledTimes(1);
      expect(f.writer).not.toHaveBeenCalled();
    }
  });
});
