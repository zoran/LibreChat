import { getConfiguredAdministratorPolicy } from './configuredAdministrators';
import { emailCodeAddressSchema } from './emailCodeAddress';

const valid = () => ({
  PLATFORM_ADMIN_EMAILS_JSON: '["zoran.kikic@bwi.de","dennis.maier@bwi.de"]',
  PLATFORM_ADMIN_POLICY_REVISION: '1',
  EMAIL_CODE_TENANT_ID: 'cortex-bwi',
  EMAIL_CODE_ALLOWED_DOMAINS: 'bwi.de',
});

describe('server-only configured administrator policy', () => {
  it('keeps canonical mailbox handling identical to email-code authentication', () => {
    expect(emailCodeAddressSchema.parse('  Zoran.Kikic@BWI.DE ')).toBe('zoran.kikic@bwi.de');
  });
  it('returns a sorted immutable tenant-bound policy', () => {
    const policy = getConfiguredAdministratorPolicy(valid())!;
    expect(policy).toEqual({
      revision: 1,
      tenantId: 'cortex-bwi',
      emails: ['dennis.maier@bwi.de', 'zoran.kikic@bwi.de'],
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.emails)).toBe(true);
  });
  it('admits only explicitly listed canonical addresses from configured public or hidden domains', () => {
    const env = {
      ...valid(),
      EMAIL_CODE_HIDDEN_ALLOWED_DOMAINS: 'private.example.test',
      PLATFORM_ADMIN_EMAILS_JSON: '["operator@private.example.test","zoran.kikic@bwi.de"]',
      PLATFORM_ADMIN_POLICY_REVISION: '2',
    };
    expect(getConfiguredAdministratorPolicy(env)?.emails).toEqual([
      'operator@private.example.test',
      'zoran.kikic@bwi.de',
    ]);
    expect(() =>
      getConfiguredAdministratorPolicy({ ...env, EMAIL_CODE_HIDDEN_ALLOWED_DOMAINS: '' }),
    ).toThrow();
    expect(() =>
      getConfiguredAdministratorPolicy({
        ...env,
        PLATFORM_ADMIN_EMAILS_JSON: '["operator@sub.private.example.test"]',
      }),
    ).toThrow();
    expect(() =>
      getConfiguredAdministratorPolicy({
        ...env,
        EMAIL_CODE_HIDDEN_ALLOWED_DOMAINS: '*.example.test',
      }),
    ).toThrow();
  });
  it('distinguishes absent configuration from explicit removal', () => {
    expect(getConfiguredAdministratorPolicy({})).toBeUndefined();
    expect(
      getConfiguredAdministratorPolicy({
        ...valid(),
        PLATFORM_ADMIN_EMAILS_JSON: '[]',
        PLATFORM_ADMIN_POLICY_REVISION: '2',
      })?.emails,
    ).toEqual([]);
  });
  it.each([
    { PLATFORM_ADMIN_EMAILS_JSON: undefined },
    { PLATFORM_ADMIN_POLICY_REVISION: undefined },
    { PLATFORM_ADMIN_POLICY_REVISION: '' },
    { PLATFORM_ADMIN_POLICY_REVISION: '0' },
    { PLATFORM_ADMIN_POLICY_REVISION: '-1' },
    { PLATFORM_ADMIN_POLICY_REVISION: '01' },
    { PLATFORM_ADMIN_POLICY_REVISION: '1.0' },
    { PLATFORM_ADMIN_POLICY_REVISION: '1e2' },
    { PLATFORM_ADMIN_POLICY_REVISION: ' 1' },
    { PLATFORM_ADMIN_POLICY_REVISION: '9007199254740992' },
    { PLATFORM_ADMIN_EMAILS_JSON: '{}' },
    { PLATFORM_ADMIN_EMAILS_JSON: 'null' },
    { PLATFORM_ADMIN_EMAILS_JSON: '[' },
    { PLATFORM_ADMIN_EMAILS_JSON: '[3]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["a%b@bwi.de"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["Zoran.Kikic@bwi.de"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '[" zoran.kikic@bwi.de"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["zoran.kikic@bwi.de","zoran.kikic@bwi.de"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["zoran.kikic@sub.bwi.de"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["zoran.kikic@bwi.de.attacker.test"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["zoran.kikic+alias@example.test"]' },
    { PLATFORM_ADMIN_EMAILS_JSON: '["zoran.kikic＠bwi.de"]' },
    {
      PLATFORM_ADMIN_EMAILS_JSON: JSON.stringify(
        Array.from({ length: 65 }, (_, i) => `person${i}@bwi.de`),
      ),
    },
    { PLATFORM_ADMIN_EMAILS_JSON: JSON.stringify(['a'.repeat(248) + '@bwi.de']) },
    { EMAIL_CODE_TENANT_ID: '' },
    { EMAIL_CODE_TENANT_ID: '__SYSTEM__' },
    { EMAIL_CODE_TENANT_ID: 'other tenant' },
    { EMAIL_CODE_TENANT_ID: 'a'.repeat(129) },
  ])('rejects malformed or ambiguous configuration: %j', (change) => {
    expect(() => getConfiguredAdministratorPolicy({ ...valid(), ...change })).toThrow(
      'Invalid configured platform administrator policy',
    );
  });
  it('accepts the agreed bounds without implicit privilege changes', () => {
    const emails = Array.from({ length: 64 }, (_, i) => `person${i}@bwi.de`);
    const policy = getConfiguredAdministratorPolicy({
      ...valid(),
      PLATFORM_ADMIN_EMAILS_JSON: JSON.stringify(emails),
      PLATFORM_ADMIN_POLICY_REVISION: String(Number.MAX_SAFE_INTEGER),
    });
    expect(policy?.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(policy?.emails).toHaveLength(64);
  });
});
