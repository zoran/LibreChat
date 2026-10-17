/** Protect the literal/context boundary: a keyword hit is neither a classification nor approval. */
import type { SecurityMarkingEvidence, SecurityMarkingPolicy } from './markings';
import { inspectSecurityMarkings } from './markings';

const policy: SecurityMarkingPolicy = {
  version: 1,
  markings: ['VS-NfD', 'VS-VERTRAULICH', 'GEHEIM', 'STRENG GEHEIM'],
  labels: ['Einstufung', 'Schutzbedarf'],
  prose: [
    { before: 'Die Kennzeichnung', after: 'wird hier als Beispiel erläutert.' },
    { before: 'In diesem Handbuch wird', after: 'nur als Begriff erklärt.' },
  ],
};

function document(
  text: string,
  placement: SecurityMarkingEvidence['units'][number]['placement'] = 'body',
): SecurityMarkingEvidence {
  return {
    version: 1,
    coverage: { complete: true, pages: 1, parts: 1 },
    units: [{ part: 1, page: 1, placement, text }],
  };
}

const rejected = { decision: 'rejected', reason: 'classification_marking' };
const ambiguous = { decision: 'uninspectable', reason: 'ambiguous_marking' };
const incomplete = { decision: 'uninspectable', reason: 'incomplete_coverage' };
const invalid = { decision: 'uninspectable', reason: 'invalid_content' };
const limited = { decision: 'uninspectable', reason: 'resource_limit' };

describe('bounded literal marking inspection', () => {
  it('allows ordinary private business prose without elevating substrings into markings', () => {
    expect(
      inspectSecurityMarkings(
        policy,
        document(
          'Diese interne Notiz ist vertraulich. Geheimnisse sind kein Geheimhaltungsvermerk.',
        ),
      ),
    ).toEqual({ decision: 'clear' });
  });

  it.each(policy.markings)('recognizes the configured standalone classification %s', (marking) => {
    expect(inspectSecurityMarkings(policy, document(marking, 'heading'))).toEqual(rejected);
  });

  it.each(['metadata', 'heading', 'margin'] as const)(
    'recognizes markings in %s after harmless earlier content',
    (placement) => {
      const evidence = document('Normale erste Seite.');
      evidence.coverage.pages = 3;
      evidence.units = [
        ...evidence.units,
        { part: 1, page: 2, placement: 'body', text: 'Normale zweite Seite.' },
        { part: 1, page: 3, placement, text: 'VS-NfD' },
      ];
      expect(inspectSecurityMarkings(policy, evidence)).toEqual(rejected);
    },
  );

  it('inspects document metadata without inventing a page for it', () => {
    const evidence = document('Normale Seite.');
    evidence.units = [
      ...evidence.units,
      { part: 1, page: null, placement: 'metadata', text: 'Einstufung: GEHEIM' },
    ];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(rejected);
  });

  it.each([
    'vs\u2011nFd',
    'VS-\nNfD',
    'ＶＳ－ＮｆＤ',
    'V S - N f D',
    'VS-VERTRAU-\nLICH',
    'G.E.H.E.I.M',
    'Projektbericht\nGEHEIM',
  ])('recognizes bounded typography and line wrapping: %s', (text) => {
    expect(inspectSecurityMarkings(policy, document(text, 'heading'))).toEqual(rejected);
  });

  it('recognizes an explicit literal classification field in body text', () => {
    expect(inspectSecurityMarkings(policy, document('Einstufung: VS-NfD'))).toEqual(rejected);
  });

  it.each([
    'Die Kennzeichnung „VS-NfD“ wird hier als Beispiel erläutert.',
    'In diesem Handbuch wird GEHEIM nur als Begriff erklärt.',
  ])('does not mistake a complete configured explanation for a classification: %s', (text) => {
    expect(inspectSecurityMarkings(policy, document(text))).toEqual({ decision: 'clear' });
  });

  it.each([
    'Dieses Dokument ist GEHEIM.',
    'Ein ungeklärter Hinweis auf VS-NfD bleibt zu prüfen.',
    'GEHEIM',
    'Die Kennzeichnung VS-NfD wird hier als Beispiel erläutert. Einstufung: GEHEIM',
  ])('keeps unresolved body mentions uninspectable: %s', (text) => {
    expect(inspectSecurityMarkings(policy, document(text))).toEqual(ambiguous);
  });

  it('does not apply the prose exception to a heading or swallow a marking on a later page', () => {
    const explanation = 'Die Kennzeichnung GEHEIM wird hier als Beispiel erläutert.';
    expect(inspectSecurityMarkings(policy, document(explanation, 'heading'))).toEqual(ambiguous);
    const evidence = document(explanation);
    evidence.coverage.pages = 2;
    evidence.units = [...evidence.units, { part: 1, page: 2, placement: 'margin', text: 'GEHEIM' }];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(rejected);
  });

  it('keeps classes configurable instead of hardcoding a platform vocabulary', () => {
    const custom = { version: 1, markings: ['PROJECT AMBER'] };
    expect(inspectSecurityMarkings(custom, document('PROJECT AMBER', 'margin'))).toEqual(rejected);
    expect(inspectSecurityMarkings(custom, document('VS-NfD', 'margin'))).toEqual({
      decision: 'clear',
    });
  });

  it('normalizes configured policy literals and evidence to the same Unicode form', () => {
    expect(
      inspectSecurityMarkings(
        { version: 1, markings: ['RE\u0301SERVE\u0301'] },
        document('réservé', 'heading'),
      ),
    ).toEqual(rejected);
  });

  it.each(['GE\u200bHEIM', 'GE\u202eHEIM', 'GЕHEIM', 'GEΗEIM'])(
    'does not clear obscured or confusable evidence: %s',
    (text) => {
      expect(inspectSecurityMarkings(policy, document(text, 'heading'))).toEqual(ambiguous);
    },
  );

  it('permits separate ordinary Unicode words without treating all non-ASCII text as obfuscation', () => {
    expect(
      inspectSecurityMarkings(policy, document('Grüße aus Köln. α ist eine Variable.')),
    ).toEqual({
      decision: 'clear',
    });
  });

  it.each(['bad\u0000text', 'bad\ufffdtext', 'bad\ud800text'])(
    'refuses malformed text instead of inspecting a repaired subset',
    (text) => {
      expect(inspectSecurityMarkings(policy, document(text))).toEqual(invalid);
    },
  );

  it('requires every declared page and part, including later unmarked parts', () => {
    const evidence = document('Harmloser Inhalt.');
    evidence.coverage.pages = 2;
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
    evidence.units = [...evidence.units, ...evidence.units];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
    evidence.coverage.pages = 1;
    evidence.coverage.parts = 2;
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
    evidence.units = [
      ...evidence.units,
      { part: 2, page: null, placement: 'metadata', text: 'Normale Metadaten.' },
    ];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual({ decision: 'clear' });
  });

  it('refuses claimed incomplete coverage even when the supplied portion has a marking', () => {
    const evidence = document('GEHEIM', 'heading');
    evidence.coverage.complete = false;
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
    evidence.coverage.complete = true;
    evidence.units = [];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
  });

  it.each([
    null,
    {},
    { ...document('ok'), version: 2 },
    { ...document('ok'), coverage: { complete: true, pages: 0, parts: 1 } },
    { ...document('ok'), coverage: { complete: true, pages: 1.1, parts: 1 } },
    { ...document('ok'), units: [{ part: 1, page: 1, placement: 'untrusted', text: 'ok' }] },
    { ...document('ok'), units: [{ part: 1, page: 1, placement: 'body', text: 'ok', url: 'x' }] },
  ])('fails closed for malformed closed-record evidence %#', (evidence) => {
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(invalid);
  });

  it('rejects out-of-range coverage references', () => {
    const evidence = document('ok');
    evidence.units = [{ part: 1, page: 2, placement: 'body', text: 'ok' }];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
    evidence.units = [{ part: 1, page: null, placement: 'body', text: 'ok' }];
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(incomplete);
  });

  it.each([
    { version: 1, markings: [] },
    { version: 1, markings: ['.*'] },
    { version: 1, markings: ['GEHEIM'], regex: '.*' },
    { version: 1, markings: ['GEHEIM', 'geheim'] },
    { version: 1, markings: ['GEHEIM'], prose: [{ before: '', after: '' }] },
  ])('accepts only valid literal policy records %#', (candidate) => {
    expect(inspectSecurityMarkings(candidate, document('ok'))).toEqual(invalid);
  });

  it('rejects accessor-bearing input without invoking policy or evidence code', () => {
    let accessed = false;
    const candidate = Object.defineProperty({ version: 1 }, 'markings', {
      enumerable: true,
      get() {
        accessed = true;
        return ['GEHEIM'];
      },
    });
    expect(inspectSecurityMarkings(candidate, document('ok'))).toEqual(invalid);
    const evidence = document('ok');
    Object.defineProperty(evidence.units[0], 'text', {
      get() {
        accessed = true;
        return 'GEHEIM';
      },
    });
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(invalid);
    expect(accessed).toBe(false);
  });

  it('refuses sparse arrays instead of skipping an uninspected unit', () => {
    const evidence = document('ok');
    evidence.units = new Array(2);
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(invalid);
  });

  it('bounds units, individual UTF-8 bytes, total text and policy size before classification', () => {
    expect(inspectSecurityMarkings(policy, document('ä'.repeat(32_769)))).toEqual(limited);
    const evidence = document('ok');
    evidence.units = Array(4097).fill(evidence.units[0]);
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(limited);
    evidence.units = Array(256).fill({
      part: 1,
      page: 1,
      placement: 'body',
      text: 'a'.repeat(65_536),
    });
    expect(inspectSecurityMarkings(policy, evidence)).toEqual(limited);
    expect(
      inspectSecurityMarkings(
        { version: 1, markings: Array.from({ length: 65 }, (_, index) => `CLASS ${index}`) },
        document('ok'),
      ),
    ).toEqual(limited);
  });

  it('returns only finite content-free decisions, never a byte-bound approval', () => {
    const evidence = document('Private example token 87246');
    const before = JSON.stringify(evidence);
    expect(inspectSecurityMarkings(policy, evidence)).toEqual({ decision: 'clear' });
    expect(JSON.stringify(evidence)).toBe(before);
    expect(inspectSecurityMarkings(policy, document('GEHEIM', 'heading'))).toEqual(rejected);
    expect(inspectSecurityMarkings(policy, document('Private token 87246: GEHEIM'))).toEqual(
      ambiguous,
    );
  });
});
