import express from 'express';
import request from 'supertest';
import type { HousekeepingObservation } from '../housekeeping/runtime';
import { createMetrics } from './metrics';

describe('authenticated Housekeeping metrics composition', () => {
  const value = (): HousekeepingObservation => ({
    identity: {
      podUid: '11111111-1111-1111-1111-111111111111',
      incarnation: '22222222-2222-4222-8222-222222222222',
      source: 'a'.repeat(40),
      hostId: 'lx-s-bwi-cpu-2',
    },
    lifecycle: 'ready',
    admitting: true,
    activeWorkCount: 1,
  });
  afterEach(() => {
    delete process.env.METRICS_SECRET;
  });

  it('never invokes the reader while disabled or before bearer authentication', async () => {
    const observe = jest.fn(value);
    const disabled = createMetrics({ collectHousekeepingObservation: observe });
    const app = express();
    app.use('/metrics', disabled.metricsRouter);
    await request(app).get('/metrics').expect(401);
    disabled.detachHousekeepingMetrics();
    process.env.METRICS_SECRET = 'test-secret';
    const enabled = createMetrics({ collectHousekeepingObservation: observe });
    const authenticated = express();
    authenticated.use('/metrics', enabled.metricsRouter);
    for (const token of ['', 'test-secret', 'Basic test-secret', 'Bearer wrong-token']) {
      const req = request(authenticated).get('/metrics');
      if (token) req.set('Authorization', token);
      await req.expect(401);
    }
    expect(observe).not.toHaveBeenCalled();
    expect(
      (await enabled.registry.getMetricsAsJSON())
        .filter((m) => m.name.startsWith('cortex_housekeeping_'))
        .flatMap((m) => m.values),
    ).toEqual([]);
  });

  it('collects once after authorization, fails closed on invalid observation and detaches', async () => {
    process.env.METRICS_SECRET = 'test-secret';
    const observe = jest.fn(value);
    const metrics = createMetrics({ collectHousekeepingObservation: observe });
    const app = express();
    app.use('/metrics', metrics.metricsRouter);
    const first = await request(app)
      .get('/metrics')
      .set('Authorization', 'bearer test-secret')
      .expect(200);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(first.text).toContain('cortex_housekeeping_instance_info');
    observe.mockReturnValue({ ...value(), activeWorkCount: 2 });
    await request(app).get('/metrics').set('Authorization', 'Bearer test-secret').expect(500);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(
      (await metrics.registry.getMetricsAsJSON())
        .filter((m) => m.name.startsWith('cortex_housekeeping_'))
        .flatMap((m) => m.values),
    ).toEqual([]);
    metrics.detachHousekeepingMetrics();
    await request(app).get('/metrics').set('Authorization', 'Bearer test-secret').expect(500);
    expect(observe).toHaveBeenCalledTimes(2);
  });
});
