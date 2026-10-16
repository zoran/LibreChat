import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { emailCodeLandingHtml } from './emailCodeLanding';
const headers = {
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
};
const html = readFileSync(resolve(__dirname, '../../../../client/index.html'), 'utf8');
it('admits only user navigation and removes RUM before bootstrap', () => {
  expect(emailCodeLandingHtml(html, headers)).toContain('data-email-click-navigation="true"');
  for (const h of [
    {},
    { ...headers, 'sec-fetch-user': undefined },
    { ...headers, purpose: 'prefetch' },
  ])
    expect(emailCodeLandingHtml(html, h)).toContain('data-email-click-navigation="false"');
  expect(emailCodeLandingHtml(html, headers)).not.toContain('data-lc-rum-bootstrap="true"');
});
it('first script scrubs before resources and keeps secrets only in memory', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link'));
  const window = {};
  const history = { replaceState: jest.fn() };
  vm.runInNewContext(script, {
    window,
    history,
    location: {
      pathname: '/login/email-code',
      hash: '#attemptId=' + 'a'.repeat(43) + '&code=01234567',
    },
    document: { documentElement: { getAttribute: () => 'true' } },
  });
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/login/email-code');
  expect(window).toMatchObject({ __emailCodeLink: { code: '01234567', activated: true } });
});
