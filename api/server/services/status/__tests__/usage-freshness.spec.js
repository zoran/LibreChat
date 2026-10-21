/** @jest-environment node */
const dto = require('librechat-data-provider');
const fixture = require('../../../../../e2e/presentation/status.full-usage.fixture.json');
const { createProjector } = require('../projection');

it.each(['lastHour', 'history'])(
  'ages admitted %s valuation before or with its token dependency',
  (window) => {
    for (const valuationMaxAge of [80, 60]) {
      const wire = JSON.parse(JSON.stringify(fixture));
      const now = wire.usage.current.at;
      const groups =
        window === 'lastHour' ? wire.usage.lastHour.groups : wire.usage.history.rows[0];
      groups[2] = [0, now - 20, 0, 0, ...Array(18).fill(0)];
      groups[4] = [0, now - 10, 0, 0, ...Array(7).fill(0)];
      wire.usage.maxAgeSeconds[2] = 90;
      wire.usage.maxAgeSeconds[4] = valuationMaxAge;
      const snapshot = dto.readStatusSnapshot(wire);
      expect(snapshot).not.toBeNull();
      const projector = createProjector(dto);
      const target = (value) =>
        window === 'lastHour' ? value.usage.lastHour.groups : value.usage.history.rows[0].groups;
      const expiry = now - 10 + valuationMaxAge;
      expect(target(projector.age(snapshot, expiry)).valuation.quality).toBe('complete');
      const aged = projector.age(snapshot, expiry + 0.5);
      expect(target(aged).valuation.quality).toBe('stale');
      expect(target(aged).tokens.quality).toBe(valuationMaxAge === 80 ? 'stale' : 'complete');
      expect(dto.readStatusSnapshot(dto.encodeStatusSnapshot(aged))).not.toBeNull();
      const terminalAge = projector.age(snapshot, now + 90);
      expect(target(terminalAge).tokens.quality).toBe('stale');
      expect(target(terminalAge).valuation.quality).toBe('stale');
    }
  },
);
