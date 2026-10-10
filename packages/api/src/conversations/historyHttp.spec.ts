import type { Request, Response } from 'express';
import { createHistoryMutationHandler, trackHistoryWrite } from './historyHttp';
import { createHistoryMutationOwner } from './history';

function fixture() {
  const owner = createHistoryMutationOwner();
  const req = { app: { locals: { historyMaintenance: owner } } } as unknown as Request;
  const res = {
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { owner, req, res };
}

describe('actual history middleware lifetimes', () => {
  it('joins middleware work after next and downstream persistence', async () => {
    const { owner, req, res } = fixture();
    let upstream!: () => void;
    let save!: () => void;
    const middleware = new Promise<void>((resolve) => {
      upstream = resolve;
    });
    const persistence = new Promise<void>((resolve) => {
      save = resolve;
    });
    const handler = createHistoryMutationHandler(
      'message-save',
      async (_req, _res, next) => {
        next();
        await middleware;
      },
      async () => {
        await trackHistoryWrite(req, () => persistence);
      },
    );
    const work = handler(req, res, jest.fn());
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
    save();
    await Promise.resolve();
    expect((await owner.getMaintenanceCensus('a')).queuedContinuations).toBeGreaterThan(0);
    upstream();
    await work;
    expect(await owner.getMaintenanceCensus('a')).toMatchObject({
      pendingWrites: 0,
      queuedContinuations: 0,
      complete: true,
    });
  });

  it('retains a callback middleware which has not yet called next', async () => {
    const { owner, req, res } = fixture();
    let advance!: () => void;
    const handler = createHistoryMutationHandler(
      'conversation-import',
      (_req, _res, next) => {
        advance = next;
      },
      async () => {},
    );
    const work = handler(req, res, jest.fn());
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('a')).queuedContinuations).toBeGreaterThan(0);
    advance();
    await work;
    expect((await owner.getMaintenanceCensus('a')).queuedContinuations).toBe(0);
  });

  it('does not start middleware without injection or after pause', async () => {
    const { owner, req, res } = fixture();
    const mutate = jest.fn();
    const handler = createHistoryMutationHandler('message-save', mutate);
    owner.pauseAdmissions('a');
    await handler(req, res, jest.fn());
    delete req.app.locals.historyMaintenance;
    await handler(req, res, jest.fn());
    expect(mutate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('settles an awaited terminal validation refusal without persistence', async () => {
    const { owner, req, res } = fixture();
    const mutate = jest.fn();
    await createHistoryMutationHandler(
      'message-save',
      async () => {
        res.status(400).json({ error: 'invalid' });
      },
      mutate,
    )(req, res, jest.fn());
    expect(mutate).not.toHaveBeenCalled();
    expect(await owner.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });
});
