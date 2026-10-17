import { request } from 'librechat-data-provider';
import { getFileLibrary, updateFileLibrary } from './api';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('../../../../packages/data-provider/src/file-library'),
  apiBaseUrl: () => '',
  request: { authenticatedFetch: jest.fn() },
}));
const fetch = jest.mocked(request.authenticatedFetch);
const response = (body: unknown, status = 200) =>
  ({
    ok: status === 200,
    status,
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: jest.fn().mockResolvedValue(body),
  }) as unknown as Response;
beforeEach(() => fetch.mockReset());

it('uses native authenticated no-store transport and canonical bounded defaults', async () => {
  fetch.mockResolvedValue(response({ files: [], nextCursor: null }));
  await expect(
    getFileLibrary({ search: '  budget  ' }, new AbortController().signal),
  ).resolves.toEqual({ files: [], nextCursor: null });
  expect(fetch).toHaveBeenCalledWith(
    '/api/files/library?limit=25&archive=active&search=budget',
    expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }),
  );
});

it('accepts bounded empty intermediate pages and rejects private/malformed responses', async () => {
  fetch.mockResolvedValueOnce(response({ files: [], nextCursor: 'aaaaaaaaaaaaaaaaaaaaaaaa' }));
  await expect(getFileLibrary({}, new AbortController().signal)).resolves.toMatchObject({
    nextCursor: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  });
  fetch.mockResolvedValueOnce(response({ files: [], nextCursor: null, private: 'secret' }));
  await expect(getFileLibrary({}, new AbortController().signal)).rejects.toMatchObject({
    status: 0,
  });
});

it('preserves 409 conflict and never retries a metadata mutation', async () => {
  fetch.mockResolvedValue(response({}, 409));
  await expect(
    updateFileLibrary(
      'file/id',
      { expectedRevision: 2, tags: [' label '] },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    '/api/files/file%2Fid/library',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 2, tags: ['label'] }),
    }),
  );
});

it.each([401, 403, 404, 503])('fails closed on HTTP %s', async (status) => {
  fetch.mockResolvedValue(response({}, status));
  await expect(getFileLibrary({}, new AbortController().signal)).rejects.toMatchObject({ status });
});

it('cancels transport on identity/filter cancellation and does not consume its late body', async () => {
  const controller = new AbortController();
  const result = response({ files: [], nextCursor: null });
  fetch.mockImplementation(async (_url, options) => {
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
    return result;
  });
  await expect(getFileLibrary({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('rejects unbounded queries and invalid mutations before transport', async () => {
  await expect(getFileLibrary({ limit: 100 }, new AbortController().signal)).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    updateFileLibrary('file', { expectedRevision: -1, tags: [] }, new AbortController().signal),
  ).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});
