const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('auth router exposes the exact private browser owner without creating an HTTP route', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
  const browserAuth = {
    pauseAdmissions: jest.fn(() => true),
    resumeAdmissions: jest.fn(() => true),
    getMaintenanceCensus: jest.fn(async () => ({ complete: false })),
  };
  const router = () => {};
  const module = { exports: router };
  vm.runInNewContext(source.slice(source.indexOf('module.exports.browserMaintenance =')), {
    module,
    browserAuth,
    Object,
  });
  expect(module.exports).toBe(router);
  expect(Object.isFrozen(module.exports.browserMaintenance)).toBe(true);
  for (const name of Object.keys(browserAuth))
    expect(module.exports.browserMaintenance[name]).toBe(browserAuth[name]);
  await expect(module.exports.browserMaintenance.getMaintenanceCensus('op')).resolves.toEqual({
    complete: false,
  });
  expect(browserAuth.getMaintenanceCensus).toHaveBeenCalledWith('op');
  expect(source).not.toMatch(/router\.(get|post|use)\([^\n]*maintenance/i);
});
