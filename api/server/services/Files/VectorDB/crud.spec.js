/** Vector deletion must confirm absence before the native File owner removes metadata. */
jest.mock('axios', () => ({
  delete: jest.fn(),
  isAxiosError: (error) => error?.isAxiosError === true,
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  runAsSystem: (fn) => fn(),
}));
jest.mock('@librechat/api', () => ({
  // Keep the current File lifecycle real while simulating the external vector provider.
  requiresLegacyVectorDeletion: jest.requireActual('../../../../../packages/api/src/files/deletion')
    .requiresLegacyVectorDeletion,
  requestManagedFileDeletion: jest.requireActual(
    '../../../../../packages/api/src/files/managedDeletion',
  ).requestManagedFileDeletion,
  fileDeletionWorkOwner: jest
    .requireActual('../../../../../packages/api/src/files/deletion')
    .createFileDeletionWorkOwner(),
  ...jest.requireActual('../../../../../packages/api/src/utils/errors'),
  logAxiosError: jest.fn(
    jest.requireActual('../../../../../packages/api/src/utils/axios').logAxiosError,
  ),
  generateShortLivedToken: jest.fn(() => 'fixture-vector-token'),
}));
jest.mock('~/server/services/Files/images', () => ({}));
jest.mock('~/server/controllers/assistants/v2', () => ({}));
jest.mock('~/server/controllers/assistants/helpers', () => ({}));
jest.mock('~/server/services/Tools/credentials', () => ({}));
jest.mock('~/server/utils/getFileStrategy', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/utils/queue', () => ({}));
jest.mock('~/server/utils', () => ({}));
jest.mock('~/server/services/Files/retention', () => ({}));
jest.mock('~/server/services/Files/Audio/STTService', () => ({}));
jest.mock('~/server/services/Uploads', () => ({ getUploadRuntime: () => undefined }), {
  virtual: true,
});
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({
    deleteFile: jest.requireActual('./crud').deleteVectors,
  }),
}));
jest.mock('~/models', () => ({
  deleteFiles: jest.fn(),
  removeAgentResourceFilesFromAllAgents: jest.fn(),
}));

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { logAxiosError, generateShortLivedToken } = require('@librechat/api');
const db = require('~/models');
const { processDeleteRequest } = require('../process');
const { deleteVectors } = require('./crud');

describe('native vector deletion confirmation', () => {
  const originalRagUrl = process.env.RAG_API_URL;
  const req = { user: { id: 'owner-1' }, body: {}, config: { endpoints: {} } };
  const file = { file_id: 'vector-file-1', embedded: true, source: FileSources.vectordb };
  const sensitive = 'https://fixture.invalid/private-document?token=fixture-secret';
  const authorization = `Bearer ${generateShortLivedToken()}`;

  function rejectedRequest(status) {
    return Object.assign(new Error(`file not found at ${sensitive}`), {
      isAxiosError: true,
      request: { authorization },
      config: { method: 'delete', url: sensitive },
      ...(status !== undefined && {
        response: {
          status,
          headers: { authorization },
          data: 'private-document-content',
        },
      }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    axios.delete.mockReset();
    process.env.RAG_API_URL = 'http://rag.fixture.invalid';
    db.deleteFiles.mockResolvedValue(undefined);
    db.removeAgentResourceFilesFromAllAgents.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalRagUrl === undefined) delete process.env.RAG_API_URL;
    else process.env.RAG_API_URL = originalRagUrl;
  });

  it.each([
    ['a transport rejection without a response', undefined],
    ['a rejected non-404 HTTP response', 503],
    ['a rejected response with a success status', 200],
    ['an unvalidated string status', '404'],
  ])('rejects %s without disclosing provider diagnostics', async (_label, status) => {
    axios.delete.mockRejectedValue(rejectedRequest(status));

    await expect(deleteVectors(req, file)).rejects.toThrow(
      'An error occurred during file deletion.',
    );
    expect(logAxiosError).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Error deleting vectors, file will not be deleted',
      expect.objectContaining({ type: 'Error' }),
    );
    const diagnostics = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls]);
    for (const value of [sensitive, 'fixture-vector-token', 'private-document-content']) {
      expect(diagnostics).not.toContain(value);
    }
  });

  it('accepts an explicit numeric 404 as already absent without logging its payload', async () => {
    axios.delete.mockRejectedValue(rejectedRequest(404));
    await expect(deleteVectors(req, file)).resolves.toBeUndefined();
    expect(logAxiosError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves the fulfilled delete response and authenticated file selection', async () => {
    const response = { status: 204, data: undefined };
    axios.delete.mockResolvedValue(response);
    await expect(deleteVectors(req, file)).resolves.toBe(response);
    expect(axios.delete).toHaveBeenCalledWith('http://rag.fixture.invalid/documents', {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      data: [file.file_id],
    });
  });

  it.each([false, undefined])('skips a file without vectors (embedded=%s)', async (embedded) => {
    await expect(deleteVectors(req, { ...file, embedded })).resolves.toBeUndefined();
    expect(axios.delete).not.toHaveBeenCalled();
    expect(generateShortLivedToken).not.toHaveBeenCalled();
  });

  it('preserves the configured skip when no RAG endpoint exists', async () => {
    delete process.env.RAG_API_URL;
    await expect(deleteVectors(req, file)).resolves.toBeUndefined();
    expect(axios.delete).not.toHaveBeenCalled();
    expect(generateShortLivedToken).not.toHaveBeenCalled();
  });

  it.each([
    ['transport failure', undefined],
    ['provider failure', 503],
  ])(
    'keeps File metadata pending after %s, despite misleading not-found text',
    async (_label, status) => {
      axios.delete.mockRejectedValue(rejectedRequest(status));

      await expect(processDeleteRequest({ req, files: [file] })).resolves.toEqual({
        deletedFileIds: [],
        failedFileIds: [file.file_id],
      });
      expect(db.deleteFiles).not.toHaveBeenCalled();
      expect(db.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
      const loggedErrors = logger.error.mock.calls.flat().filter((value) => value instanceof Error);
      expect(loggedErrors).not.toHaveLength(0);
      for (const error of loggedErrors) {
        expect(error.message).toBe('An error occurred during file deletion.');
        expect(error.cause).toBeUndefined();
        expect(error.config).toBeUndefined();
        expect(error.response).toBeUndefined();
      }
    },
  );

  it.each(['success', 'already absent'])(
    'lets the File owner finalize confirmed %s',
    async (outcome) => {
      if (outcome === 'success') axios.delete.mockResolvedValue({ status: 204 });
      else axios.delete.mockRejectedValue(rejectedRequest(404));

      await expect(processDeleteRequest({ req, files: [file] })).resolves.toEqual({
        deletedFileIds: [file.file_id],
        failedFileIds: [],
      });
      expect(db.deleteFiles).toHaveBeenCalledWith([file.file_id]);
      expect(db.removeAgentResourceFilesFromAllAgents).toHaveBeenCalledWith({
        file_ids: [file.file_id],
      });
    },
  );
});
