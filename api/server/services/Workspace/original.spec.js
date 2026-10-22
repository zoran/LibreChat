/** CJS composition only; stream behavior is covered at the typed File API owner. */
jest.mock('@librechat/api', () => ({ createWorkspaceOriginalReader: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({ runAsSystem: jest.fn((work) => work()) }));
jest.mock('~/server/routes/files/managed', () => ({ createManagedFileHandlers: jest.fn() }));
jest.mock('~/server/services/Uploads', () => ({ getUploadRuntime: jest.fn() }));
jest.mock('~/models', () => ({ getDocumentWorkspaceVersionFile: jest.fn() }));

const { createWorkspaceOriginalReader: createReader } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const { createManagedFileHandlers } = require('~/server/routes/files/managed');
const uploads = require('~/server/services/Uploads');
const models = require('~/models');
const { createWorkspaceOriginalReader } = require('./original');

beforeEach(() => jest.resetAllMocks());

test('wires explicit ports and clock options into the single typed reader', () => {
  const reader = { read: jest.fn() };
  createReader.mockReturnValue(reader);
  const options = {
    getRuntime: jest.fn(),
    authorize: jest.fn(),
    getDocumentWorkspaceVersionFile: jest.fn(),
    runAsSystem: jest.fn(),
    securityPolicySha256: 'c'.repeat(64),
    now: jest.fn(),
    monotonic: jest.fn(),
    deadlineMs: 500,
  };
  expect(createWorkspaceOriginalReader(options)).toBe(reader);
  const [ports, clocks] = createReader.mock.calls[0];
  expect(ports).toEqual({
    getRuntime: options.getRuntime,
    authorize: options.authorize,
    getDocumentWorkspaceVersionFile: options.getDocumentWorkspaceVersionFile,
    runAsSystem: options.runAsSystem,
    policySha256: expect.any(Function),
  });
  expect(ports.policySha256()).toBe(options.securityPolicySha256);
  expect(clocks).toEqual({ now: options.now, monotonic: options.monotonic, deadlineMs: 500 });
  expect(createManagedFileHandlers).not.toHaveBeenCalled();
});

test('wires lazy app owners and the existing managed authorization port by default', () => {
  const authorize = jest.fn();
  createManagedFileHandlers.mockReturnValue({ authorize });
  createWorkspaceOriginalReader();
  expect(uploads.getUploadRuntime).not.toHaveBeenCalled();
  expect(models.getDocumentWorkspaceVersionFile).not.toHaveBeenCalled();
  const [ports] = createReader.mock.calls[0];
  expect(ports.authorize).toBe(authorize);
  expect(ports.runAsSystem).toBe(runAsSystem);
  ports.getRuntime();
  expect(uploads.getUploadRuntime).toHaveBeenCalledTimes(1);
  const owner = { userId: 'owner', tenantId: 'tenant' };
  ports.getDocumentWorkspaceVersionFile(owner, 'workspace', 1);
  expect(models.getDocumentWorkspaceVersionFile).toHaveBeenCalledWith(owner, 'workspace', 1);
  expect(createManagedFileHandlers).toHaveBeenCalledWith({ getRuntime: ports.getRuntime });
});
