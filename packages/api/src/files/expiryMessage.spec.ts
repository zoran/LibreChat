import { JSDOM } from 'jsdom';
import type { ExpiryMessageInput } from './expiryMessage';
import { MAIL_MOBILE_STYLES } from '../auth/mailPresentation';
import { expiryMessage } from './expiryMessage';

const input: ExpiryMessageInput = {
  appTitle: 'Cortex',
  offsetDays: 7,
  asOf: '2026-10-21T13:30:00Z',
  timezone: 'Europe/Berlin',
  clientUrl: 'https://portal.example.test/chat/',
  embeddedLogo: true,
  supportText: 'Bei Fragen hilft dir das AI Center weiter.',
  files: [
    {
      filename: 'Projektübersicht.pdf',
      acceptedAt: '2026-09-23T13:30:00Z',
      lastSuccessfulReadAt: null,
      lastReadKnown: true,
      inactivity: {
        known: true,
        since: '2026-10-18T13:30:00Z',
        fullDays: 3,
        basis: 'successful-use',
      },
      readCount: { known: true, coverage: 'complete', value: 0 },
      processingCount: { known: true, coverage: 'complete', value: 1 },
      deadlineAt: '2026-10-28T13:30:00Z',
    },
  ],
};
const body = (html: string) => new JSDOM(html).window.document;
const required = [
  'Die automatische Löschung erfolgt aus Sicherheitsgründen.',
  'Wenn du die Dateien nicht mehr benötigst, musst du nichts tun.',
  'Jeder erfolgreiche Lese- oder Verarbeitungsvorgang verschiebt den bisher geltenden Löschtermin der jeweiligen Datei um weitere sieben Tage.',
];

describe('upload expiry mail presentation', () => {
  it.each([7, 1] as const)(
    'renders the %d-day notice with all fields and equivalent German text',
    (offsetDays) => {
      const message = expiryMessage({ ...input, offsetDays });
      const doc = body(message.html);
      expect(doc.documentElement.lang).toBe('de');
      expect(message.subject).toContain(offsetDays === 7 ? 'in sieben Tagen' : 'in einem Tag');
      for (const text of required) {
        expect(message.text.split(text)).toHaveLength(2);
        expect(doc.body.textContent!.split(text)).toHaveLength(2);
      }
      for (const text of [
        'Projektübersicht.pdf',
        'Hochgeladen am',
        '23. September 2026',
        'Letzter erfolgreicher Lesezugriff',
        'Noch kein erfolgreicher Lesezugriff',
        'Erfolgreiche Lesezugriffe',
        'Erfolgreiche Verarbeitungen',
        'Vorgesehene Löschung ohne weitere Nutzung',
        '28. Oktober 2026 um 14:30 Uhr (Europe/Berlin, GMT+1)',
      ]) {
        expect(message.text).toContain(text);
        expect(doc.body.textContent).toContain(text);
      }
      expect(message.text).toContain('Diese Datei wurde seit 3 Tagen nicht mehr verwendet.');
      expect(doc.body.textContent).toContain(
        'Diese Datei wurde seit 3 Tagen nicht mehr verwendet.',
      );
      expect(doc.body.textContent!.indexOf(required[0])).toBeLessThan(
        doc.body.textContent!.indexOf('Für die folgenden Dateien'),
      );
      const values = Array.from(doc.querySelectorAll('dd')).map((element) => element.textContent);
      expect(values).toEqual([
        '23. September 2026',
        'Noch kein erfolgreicher Lesezugriff',
        '0',
        '1',
        '28. Oktober 2026 um 14:30 Uhr (Europe/Berlin, GMT+1)',
      ]);
      expect(message.text).not.toMatch(/\b(?:Sie|Ihre|Ihnen)\b|Verlängerung.*nicht möglich/);
      expect(message.html).not.toContain('Anmeldung nicht angefordert');
    },
  );

  it('keeps unknown and partial history distinct from verified zero', () => {
    const first = input.files[0];
    const message = expiryMessage({
      ...input,
      files: [
        {
          ...first,
          filename: 'Altbestand.txt',
          acceptedAt: null,
          lastReadKnown: false,
          inactivity: { known: false },
          readCount: { known: false },
          processingCount: { known: false },
        },
        {
          ...first,
          filename: 'Teilbestand.txt',
          lastReadKnown: false,
          inactivity: { known: false },
          readCount: { known: true, coverage: 'since', value: 0, since: '2026-10-20T12:00:00Z' },
          processingCount: {
            known: true,
            coverage: 'since',
            value: 2,
            since: '2026-10-20T12:00:00Z',
          },
        },
      ],
    });
    const doc = body(message.html);
    const unknown = doc.querySelectorAll('section')[0].textContent!;
    expect(unknown.match(/Nicht erfasst/g)).toHaveLength(4);
    expect(unknown).not.toContain('Noch kein erfolgreicher Lesezugriff');
    expect(message.text).toContain('0 seit 20. Oktober 2026; frühere Vorgänge nicht erfasst');
    expect(message.text).toContain(
      'Keine erfolgreichen Lesezugriffe seit 20. Oktober 2026; frühere Lesezugriffe nicht erfasst',
    );
    expect(message.text).not.toContain('Noch kein erfolgreicher Lesezugriff');
    expect(
      message.text.match(
        /Wie lange diese Datei nicht verwendet wurde, ist nicht vollständig erfasst\./g,
      ),
    ).toHaveLength(2);
    expect(doc.querySelectorAll('section')[1].textContent).toContain('2 seit 20. Oktober 2026');
  });

  it('uses the actual last user read and each current deadline without deriving policy', () => {
    const files = [
      input.files[0],
      {
        ...input.files[0],
        filename: 'Zweite Datei.pdf',
        readCount: { known: true as const, coverage: 'complete' as const, value: 2 },
        lastSuccessfulReadAt: '2026-10-18T23:30:00Z',
        deadlineAt: '2026-11-04T13:30:00Z',
      },
    ];
    const message = expiryMessage({ ...input, files });
    expect(message.text).toContain('19. Oktober 2026');
    expect(message.text).toContain('4. November 2026 um 14:30 Uhr (Europe/Berlin, GMT+1)');
    expect(input.files[0].deadlineAt).toBe('2026-10-28T13:30:00Z');
  });

  it.each([
    [0, 'successful-use', 'Diese Datei wurde vor weniger als einem Tag zuletzt verwendet.'],
    [1, 'successful-use', 'Diese Datei wurde seit einem Tag nicht mehr verwendet.'],
    [12, 'successful-use', 'Diese Datei wurde seit 12 Tagen nicht mehr verwendet.'],
    [
      0,
      'upload',
      'Diese Datei wurde vor weniger als einem Tag hochgeladen und seitdem noch nicht verwendet.',
    ],
    [1, 'upload', 'Seit dem Upload vor einem Tag wurde diese Datei noch nicht verwendet.'],
    [12, 'upload', 'Seit dem Upload vor 12 Tagen wurde diese Datei noch nicht verwendet.'],
  ] as const)(
    'uses owner-projected inactivity %d/%s without recalculating it',
    (fullDays, basis, expected) => {
      const message = expiryMessage({
        ...input,
        files: [
          {
            ...input.files[0],
            // Deliberately independent of the wall clock: the snapshot owner supplies fullDays.
            inactivity: { known: true, since: '2026-10-18T13:30:00Z', fullDays, basis },
          },
        ],
      });
      expect(message.text).toContain(expected);
      expect(body(message.html).body.textContent).toContain(expected);
      expect(message.text).toContain(
        'Stand vom 21. Oktober 2026 um 15:30 Uhr (Europe/Berlin, GMT+2)',
      );
    },
  );

  it('does not claim a stale relative window when the caller marks the notice late', () => {
    const message = expiryMessage({ ...input, late: true });
    expect(message.subject).not.toMatch(/sieben Tagen|einem Tag/);
    expect(message.text).toContain('zu den unten genannten Terminen');
    expect(message.text).toContain('Stand vom');
  });

  it('escapes hostile and long names without markup, clipping rules or extra links', () => {
    const filename =
      '<img src="https://evil.test/pixel" onerror="x"><style>.attacker{background:url(https://evil.test/css)}</style> & \'Plan\' ' +
      '長'.repeat(600) +
      '\u202e\n';
    const message = expiryMessage({
      ...input,
      appTitle: '<b>Portal</b><style>.attacker{display:none}</style>',
      supportText:
        'Hilfe <img src="https://evil.test/help"><style>.attacker{color:red}</style> & "Team"',
      files: [{ ...input.files[0], filename }],
    });
    const doc = body(message.html);
    expect(doc.querySelectorAll('script,iframe,form,object,link,input')).toHaveLength(0);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    expect(doc.querySelectorAll('head > style')).toHaveLength(1);
    expect(doc.querySelector('head > style')!.textContent).toBe(MAIL_MOBILE_STYLES);
    expect(doc.querySelectorAll('img')).toHaveLength(1);
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('cid:application-logo@local');
    expect(doc.querySelector('h2')!.textContent).toContain('長'.repeat(600));
    expect(doc.querySelector('h2')!.textContent).toContain('\\u202e\\u000a');
    expect(message.text).toContain('\\u202e\\u000a');
    expect(doc.querySelector('h2')!.style.overflowWrap).toBe('anywhere');
    expect(message.subject).not.toContain('長');
    const link = doc.querySelector('a')!;
    expect(link.href).toBe(input.clientUrl);
    expect(link.textContent).toBe(input.clientUrl);
    expect(doc.querySelectorAll('a')).toHaveLength(1);
    expect(message.text).toContain(input.clientUrl);
  });

  it('retains semantic readable cards, the existing frame and a complete no-image/no-link fallback', () => {
    const message = expiryMessage({ ...input, embeddedLogo: false, clientUrl: undefined });
    const doc = body(message.html);
    expect(doc.querySelectorAll('img,a')).toHaveLength(0);
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelectorAll('h2,dl')).toHaveLength(2);
    expect(doc.querySelector('section')!.getAttribute('aria-labelledby')).toBe(
      doc.querySelector('h2')!.id,
    );
    expect(doc.querySelectorAll('dt')).toHaveLength(5);
    for (const table of doc.querySelectorAll('table'))
      expect(table.getAttribute('role')).toBe('presentation');
    expect(message.html).toContain('max-width:600px');
    expect(message.html).toContain('Arial,Helvetica,sans-serif');
    expect(message.text).toContain('Cortex');
    expect(message.text).not.toContain('https://');
    expect(doc.body.textContent).toContain(input.supportText);
  });

  it('formats absolute dates in the explicit zone across the daylight-saving change', () => {
    const message = expiryMessage({
      ...input,
      asOf: '2026-10-25T00:30:00Z',
      files: [{ ...input.files[0], deadlineAt: '2026-10-25T01:30:00Z' }],
    });
    expect(message.text).toContain('25. Oktober 2026 um 02:30 Uhr (Europe/Berlin, GMT+2)');
    expect(message.text).toContain('25. Oktober 2026 um 02:30 Uhr (Europe/Berlin, GMT+1)');
    expect(expiryMessage({ ...input, timezone: 'UTC' }).text).toContain('13:30 Uhr (UTC)');
  });

  it.each([
    'javascript:alert(1)',
    'https://portal.test/?file=secret',
    'https://portal.test/#read',
    'https://name:secret@portal.test/',
  ])('rejects an untrusted client URL: %s', (clientUrl) => {
    expect(() => expiryMessage({ ...input, clientUrl })).toThrow(
      'Invalid expiry mail presentation',
    );
  });

  it.each([
    { appTitle: 'Cortex\r\nBcc: someone' },
    { offsetDays: 3 },
    { timezone: 'Not/AZone' },
    { asOf: 'not-an-instant' },
    { files: [] },
    { files: [{ ...input.files[0], readCount: { known: true, coverage: 'complete', value: -1 } }] },
    {
      files: [
        { ...input.files[0], processingCount: { known: true, coverage: 'complete', value: 1.5 } },
      ],
    },
    { files: [{ ...input.files[0], deadlineAt: 'not-an-instant' }] },
    { files: [{ ...input.files[0], lastSuccessfulReadAt: input.asOf }] },
    {
      files: [
        {
          ...input.files[0],
          inactivity: { known: true, fullDays: -1, since: input.asOf, basis: 'successful-use' },
        },
      ],
    },
    {
      files: [
        {
          ...input.files[0],
          inactivity: { known: true, fullDays: 1.5, since: input.asOf, basis: 'successful-use' },
        },
      ],
    },
  ])('rejects invalid display data without inventing defaults: %j', (change) => {
    expect(() => expiryMessage({ ...input, ...change } as ExpiryMessageInput)).toThrow(
      'Invalid expiry mail presentation',
    );
  });
});
