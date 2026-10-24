import type { S3Client } from '@aws-sdk/client-s3';

const mockLogger = { info: jest.fn(), error: jest.fn() };

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ destroy: jest.fn() })),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

describe('initializeS3', () => {
  const REQUIRED_ENV = {
    AWS_REGION: 'us-east-1',
    AWS_BUCKET_NAME: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'test-key-id',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_FORCE_PATH_STYLE;
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV)) {
      delete process.env[key];
    }
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_FORCE_PATH_STYLE;
  });

  async function load() {
    const { S3Client: MockS3Client } = jest.requireMock('@aws-sdk/client-s3') as {
      S3Client: jest.MockedClass<typeof S3Client>;
    };
    const { initializeS3, getS3ClientCapture } = await import('../s3');
    return { MockS3Client, initializeS3, getS3ClientCapture };
  }

  it('should initialize with region and credentials', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        credentials: { accessKeyId: 'test-key-id', secretAccessKey: 'test-secret' },
      }),
    );
  });

  it('should include endpoint when AWS_ENDPOINT_URL is set', async () => {
    process.env.AWS_ENDPOINT_URL = 'https://fsn1.your-objectstorage.com';
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://fsn1.your-objectstorage.com' }),
    );
  });

  it('should only calculate request checksums when S3 requires them', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ requestChecksumCalculation: 'WHEN_REQUIRED' }),
    );
  });

  it('should not include endpoint when AWS_ENDPOINT_URL is not set', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('endpoint');
  });

  it('should set forcePathStyle when AWS_FORCE_PATH_STYLE is true', async () => {
    process.env.AWS_FORCE_PATH_STYLE = 'true';
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({ forcePathStyle: true }));
  });

  it('should not set forcePathStyle when AWS_FORCE_PATH_STYLE is false', async () => {
    process.env.AWS_FORCE_PATH_STYLE = 'false';
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('forcePathStyle');
  });

  it('should not set forcePathStyle when AWS_FORCE_PATH_STYLE is not set', async () => {
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('forcePathStyle');
  });

  it('should return null and log error when AWS_REGION is not set', async () => {
    delete process.env.AWS_REGION;
    const { initializeS3 } = await load();
    const result = initializeS3();
    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[initializeS3] AWS_REGION is not set. Cannot initialize S3.',
    );
  });

  it('does not label a failed construction as an unstarted client', async () => {
    const { MockS3Client, initializeS3, getS3ClientCapture } = await load();
    MockS3Client.mockImplementationOnce(() => {
      throw new Error('fixture constructor failed');
    });
    expect(() => initializeS3()).toThrow('fixture constructor failed');
    expect(getS3ClientCapture()).toBeUndefined();
  });

  it('should throw when AWS_BUCKET_NAME is not set', async () => {
    delete process.env.AWS_BUCKET_NAME;
    const { initializeS3 } = await load();
    expect(() => initializeS3()).toThrow(
      '[S3] AWS_BUCKET_NAME environment variable is required for S3 operations.',
    );
  });

  it('should return the same instance on subsequent calls', async () => {
    const { MockS3Client, initializeS3 } = await load();
    const first = initializeS3();
    const second = initializeS3();
    expect(first).toBe(second);
    expect(MockS3Client).toHaveBeenCalledTimes(1);
  });

  it('should use default credentials chain when keys are not provided', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const { MockS3Client, initializeS3 } = await load();
    initializeS3();
    const config = MockS3Client.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('credentials');
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[initializeS3] S3 initialized using default credentials (IRSA).',
    );
  });
  it('observes only the constructed instance without rereading configuration or creating a client', async () => {
    const { MockS3Client, initializeS3, getS3ClientCapture } = await load();
    expect(getS3ClientCapture()).toBeNull();
    expect(MockS3Client).not.toHaveBeenCalled();
    process.env.AWS_FORCE_PATH_STYLE = ' TRUE ';
    const client = initializeS3()!;
    const captured = getS3ClientCapture()!;
    expect(captured).toEqual({
      instanceId: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
      region: 'us-east-1',
      endpoint: null,
      forcePathStyle: true,
    });
    expect(Object.isFrozen(captured)).toBe(true);
    process.env.AWS_REGION = 'changed-region';
    process.env.AWS_ENDPOINT_URL = 'https://different.example.test';
    expect(getS3ClientCapture()).toBe(captured);
    expect(initializeS3()).toBe(client);
    expect(MockS3Client).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(captured)).not.toMatch(/test-key-id|test-secret|credentials/i);
    client.destroy();
    expect(getS3ClientCapture()).toBeUndefined();
  });

  it('invalidates before the actual destroy callback, including a throwing teardown', async () => {
    const { MockS3Client, initializeS3, getS3ClientCapture } = await load();
    const failure = new Error('fixture teardown failed');
    MockS3Client.mockImplementationOnce(
      () =>
        ({
          destroy: () => {
            expect(getS3ClientCapture()).toBeUndefined();
            throw failure;
          },
        }) as unknown as S3Client,
    );
    const client = initializeS3()!;
    expect(getS3ClientCapture()).toBeDefined();
    expect(() => client.destroy()).toThrow(failure);
    expect(getS3ClientCapture()).toBeUndefined();
  });

  it.each([
    'https://user:fixture-secret@storage.example.test',
    'https://storage.example.test/private',
    'https://storage.example.test?token=fixture-secret',
    'https://storage.example.test/#fixture-secret',
  ])('keeps SDK endpoint behavior while refusing unsafe observation: %s', async (endpoint) => {
    process.env.AWS_ENDPOINT_URL = endpoint;
    const { MockS3Client, initializeS3, getS3ClientCapture } = await load();
    const client = initializeS3()!;
    expect(MockS3Client).toHaveBeenCalledWith(expect.objectContaining({ endpoint }));
    expect(getS3ClientCapture()).toBeUndefined();
    client.destroy();
  });
});
