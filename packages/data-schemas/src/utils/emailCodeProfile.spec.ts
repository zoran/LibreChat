import { emailCodeProfileName } from './emailCodeProfile';
it.each([
  ['Marc.vonderLinden@bwi.de', 'Marc von der Linden'],
  ['marc.vonderlinden@bwi.de', 'Marc von der Linden'],
  ['marc.von.der.linden@bwi.de', 'Marc von der Linden'],
  ['max.zuber@bwi.de', 'Max Zuber'],
  ['max.zurek@bwi.de', 'Max Zurek'],
  ['max.zumbach@bwi.de', 'Max Zumbach'],
  ['max.vonnegut@bwi.de', 'Max Vonnegut'],
  ['anna-lena.mueller-schmidt@bwi.de', 'Anna-Lena Mueller-Schmidt'],
  ["jean-pierre.o'neill@bwi.de", "Jean-Pierre O'Neill"],
  ['support@bwi.de', 'support'],
  ['a123.team@bwi.de', 'a123.team'],
  ['a..b@bwi.de', 'a..b'],
  ['bad address@bwi.de', ''],
  ['john.doe@', ''],
])('formats only a bounded display convention: %s', (email, expected) => {
  expect(emailCodeProfileName(email)).toBe(expected);
});
