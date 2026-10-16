import { emailCodeGreeting } from './emailCodeGreeting';
it('uses the first token only for verified email, retaining compounds', () => {
  expect(emailCodeGreeting({ provider: 'email_code', name: 'Marc von der Linden' })).toBe('Marc');
  expect(emailCodeGreeting({ provider: 'email_code', name: 'Anna-Lena Mueller-Schmidt' })).toBe(
    'Anna-Lena',
  );
  expect(emailCodeGreeting({ provider: 'openid', name: 'Marc von der Linden' })).toBe(
    'Marc von der Linden',
  );
  expect(emailCodeGreeting({ provider: 'email_code', name: '  ' })).toBeUndefined();
});

it.each([
  ['zoran Kikic', 'Zoran'],
  ['élise Dupont', 'Élise'],
  ['özlem Yilmaz', 'Özlem'],
  ['𐐨ra Example', '𐐀ra'],
  ['e\u0301lodie Example', 'E\u0301lodie'],
  ['anna-Lena Mueller-Schmidt', 'Anna-Lena'],
  ['mAX Example', 'MAX'],
])('capitalizes only the first Unicode character of %s', (name, expected) => {
  expect(emailCodeGreeting({ provider: 'email_code', name })).toBe(expected);
});

it('preserves the original profile name while formatting the scheduled greeting', () => {
  const user = Object.freeze({ provider: 'email_code', name: '  anna-Lena Mueller-Schmidt  ' });
  expect(emailCodeGreeting(user)).toBe('Anna-Lena');
  expect(user.name).toBe('  anna-Lena Mueller-Schmidt  ');
});

it.each(['openid', 'local', undefined])(
  'preserves the full profile name for provider %s',
  (provider) => {
    expect(emailCodeGreeting({ provider, name: '  zoran Kikic  ' })).toBe('  zoran Kikic  ');
  },
);

it.each([undefined, null, { provider: 'email_code' }, { provider: 'email_code', name: '' }])(
  'preserves missing-name behavior for %p',
  (user) => expect(emailCodeGreeting(user)).toBeUndefined(),
);
