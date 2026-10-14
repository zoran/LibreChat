import { EventEmitter } from 'node:events';
import type { UploadPrincipal } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { UploadLiveOptions } from './live';
import { UploadManagementError } from './errors';
import { createUploadLiveHub } from './live';

const owner: UploadPrincipal = {
  tenantId: 'tenant',
  userId: 'one',
  authentication: 'verified-email',
};
function connection(principal = owner) {
  const request = Object.assign(new EventEmitter(), { identity: principal });
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    write: jest.fn(() => true),
    end: jest.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
    destroy: jest.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
  });
  return {
    request,
    response,
    req: request as unknown as Request,
    res: response as unknown as Response,
  };
}
function fixture() {
  let changes!: {
    onChanged: (principal: { tenantId: string; userId: string }) => void;
    onReset: () => void;
  };
  const closeWatch = jest.fn();
  const repository = {
    watchChanges: jest.fn(
      (input: Parameters<UploadLiveOptions['repository']['watchChanges']>[0]) => {
        changes = input;
        return closeWatch;
      },
    ),
  };
  const principal = jest.fn(
    async (req: Request) => (req as unknown as { identity: UploadPrincipal }).identity,
  );
  const observe = jest.fn();
  const options = { repository, principal, observe, tenantId: owner.tenantId };
  const hub = createUploadLiveHub(options);
  return { hub, repository, principal, observe, closeWatch, options, changes: () => changes };
}

describe('bounded authenticated upload event hints', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shares one watch, routes only the exact principal and coalesces a burst into one content-free hint', async () => {
    const f = fixture();
    const a = connection();
    const b = connection({ ...owner, userId: 'two' });
    await f.hub.open(a.req, a.res, owner);
    await f.hub.open(b.req, b.res, b.request.identity);
    expect(f.repository.watchChanges).toHaveBeenCalledTimes(1);
    expect(f.repository.watchChanges).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: owner.tenantId }),
    );
    a.response.write.mockClear();
    b.response.write.mockClear();
    for (let i = 0; i < 50; i++) f.changes().onChanged(owner);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(a.response.write).toHaveBeenCalledTimes(1);
    expect(a.response.write).toHaveBeenCalledWith('event: change\ndata: {}\n\n');
    expect(b.response.write).not.toHaveBeenCalled();
    f.hub.close();
    expect(f.closeWatch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses an initially valid grant for another server tenant before headers or a watch', async () => {
    const f = fixture();
    const foreign = connection({ ...owner, tenantId: 'another' });
    f.options.tenantId = foreign.request.identity.tenantId;
    try {
      await expect(
        f.hub.open(foreign.req, foreign.res, foreign.request.identity),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(foreign.response.status).not.toHaveBeenCalled();
      expect(foreign.response.write).not.toHaveBeenCalled();
      expect(f.repository.watchChanges).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      f.hub.close();
    }
  });

  it('ignores a foreign tenant hint even when its user identifier matches a connected owner', async () => {
    const f = fixture();
    const a = connection();
    try {
      await f.hub.open(a.req, a.res, owner);
      a.response.write.mockClear();
      f.changes().onChanged({ ...owner, tenantId: 'another' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(a.response.write).not.toHaveBeenCalled();
    } finally {
      f.hub.close();
    }
  });

  it('reauthorizes before disclosing a queued batch and closes immediately on revocation', async () => {
    const f = fixture();
    const a = connection();
    await f.hub.open(a.req, a.res, owner);
    a.response.write.mockClear();
    f.changes().onChanged(owner);
    f.principal.mockRejectedValueOnce(new UploadManagementError('unauthorized'));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(a.response.write).not.toHaveBeenCalled();
    expect(a.response.end).toHaveBeenCalled();
    f.hub.close();
  });

  it('rechecks idle sessions every fifteen seconds and cannot continue under another tenant', async () => {
    const f = fixture();
    const a = connection();
    await f.hub.open(a.req, a.res, owner);
    f.principal.mockResolvedValueOnce({ ...owner, tenantId: 'another' });
    await jest.advanceTimersByTimeAsync(15_000);
    expect(a.response.end).toHaveBeenCalled();
    expect(a.response.write).toHaveBeenCalledTimes(1);
    f.hub.close();
  });

  it('enforces two connections per principal and 512 per replica without adding a watch per connection', async () => {
    const f = fixture();
    const a = connection();
    const b = connection();
    const denied = connection();
    await f.hub.open(a.req, a.res, owner);
    await f.hub.open(b.req, b.res, owner);
    await expect(f.hub.open(denied.req, denied.res, owner)).rejects.toMatchObject({
      code: 'queue_full',
    });
    for (let i = 0; i < 510; i++) {
      const next = connection({ ...owner, userId: `slot-${i}` });
      await f.hub.open(next.req, next.res, next.request.identity);
    }
    const full = connection({ ...owner, userId: 'overflow' });
    await expect(f.hub.open(full.req, full.res, full.request.identity)).rejects.toMatchObject({
      code: 'queue_full',
    });
    expect(f.repository.watchChanges).toHaveBeenCalledTimes(1);
    f.hub.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('closes slow clients without buffering and closes streams by 235 seconds', async () => {
    const f = fixture();
    const slow = connection();
    slow.response.write.mockReturnValue(false);
    await f.hub.open(slow.req, slow.res, owner);
    expect(slow.response.destroy).toHaveBeenCalled();
    const normal = connection();
    await f.hub.open(normal.req, normal.res, owner);
    await jest.advanceTimersByTimeAsync(235_000);
    expect(normal.response.end).toHaveBeenCalled();
    f.hub.close();
  });

  it('uses a reset hint and one bounded replacement watch after stream loss', async () => {
    const f = fixture();
    const a = connection();
    await f.hub.open(a.req, a.res, owner);
    a.response.write.mockClear();
    f.changes().onReset();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(f.closeWatch).toHaveBeenCalledTimes(1);
    expect(a.response.write).toHaveBeenCalledWith('event: reset\ndata: {}\n\n');
    expect(f.repository.watchChanges).toHaveBeenCalledTimes(2);
    expect(f.repository.watchChanges.mock.calls.map(([input]) => input.tenantId)).toEqual([
      owner.tenantId,
      owner.tenantId,
    ]);
    f.hub.close();
  });
});
