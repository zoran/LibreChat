const particles: Record<string, string> = {
  vonder: 'von der',
  vonzu: 'von zu',
  vanden: 'van den',
  vander: 'van der',
  von: 'von',
  van: 'van',
  zur: 'zur',
  zum: 'zum',
  zu: 'zu',
};
const word = /^[\p{L}]+(?:[-'][\p{L}]+)*$/u;
const title = (value: string) =>
  value
    .toLowerCase()
    .replace(
      /(^|[-'])(\p{L})/gu,
      (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase('de-DE'),
    );

/** Display convenience after mailbox verification, never identity or authorization. */
export function emailCodeProfileName(email: string): string {
  const parts = email.split('@');
  if (
    parts.length !== 2 ||
    !/^[a-z0-9.-]+\.[a-z]{2,63}$/i.test(parts[1]) ||
    !parts[0] ||
    parts[0].length > 64 ||
    /\s/.test(email)
  )
    return '';
  const local = parts[0].toLowerCase();
  const names = local.split('.');
  if (names.length < 2 || names.length > 5 || !names.every((name) => word.test(name))) return local;
  const surname = names.slice(1).map((name) => {
    if (name === 'der' || name === 'den') return name;
    if (particles[name]) return particles[name];
    // Short prefixes also begin ordinary surnames (Zuber, Zurek, Vonnegut).
    // Only compound particles have an explicit joined-mailbox convention here.
    for (const prefix of ['vonder', 'vonzu', 'vanden', 'vander']) {
      const display = particles[prefix];
      if (name.startsWith(prefix) && /^\p{L}{3,}(?:[-']\p{L}+)*$/u.test(name.slice(prefix.length)))
        return `${display} ${title(name.slice(prefix.length))}`;
    }
    return title(name);
  });
  return [title(names[0]), ...surname].join(' ');
}
