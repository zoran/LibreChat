'use strict';

const mockAdmin = { runFileCoverageAdmin: jest.fn() };
jest.mock('@librechat/data-schemas/file-housekeeping-coverage', () => mockAdmin, { virtual: true });
const { main } = require('./file-housekeeping-coverage');

describe('fixed File coverage command entry', () => {
  test('awaits the original typed command and propagates its actual result', async () => {
    let finish;
    mockAdmin.runFileCoverageAdmin.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let returned = false;
    const pending = main().then((code) => {
      returned = true;
      return code;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    finish(1);
    expect(await pending).toBe(1);
  });
  test('does not expose private adapter errors', async () => {
    mockAdmin.runFileCoverageAdmin.mockRejectedValue(new Error('private Mongo URI'));
    expect(await main()).toBe(1);
  });
});
