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
