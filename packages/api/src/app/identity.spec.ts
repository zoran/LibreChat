import { createMaintenanceIdentity } from './identity';

describe('native process identity', () => {
  const env = {
    POD_UID: '12345678-1234-4234-8234-123456789012',
    BUILD_COMMIT: 'a'.repeat(40),
  };

  it('distinguishes process starts within the same Pod and keeps the snapshot immutable', () => {
    const first = createMaintenanceIdentity(env, true);
    const second = createMaintenanceIdentity(env, true);
    expect(first).toEqual({
      podUid: env.POD_UID,
      source: env.BUILD_COMMIT,
      incarnation: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    });
    expect(second.incarnation).not.toBe(first.incarnation);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([{}, { ...env, POD_UID: 'pod-name' }, { ...env, BUILD_COMMIT: 'mutable-image-tag' }])(
    'refuses an incomplete deployed process identity',
    (invalid) => {
      expect(() => createMaintenanceIdentity(invalid, true)).toThrow(
        'Invalid application runtime identity',
      );
    },
  );

  it('preserves the ordinary local application identity without claiming a deployed Pod', () => {
    expect(createMaintenanceIdentity({}, false)).toMatchObject({ podUid: '', source: '' });
  });
});
