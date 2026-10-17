import type { SecurityMarkingEvidence } from './markings';
import { inspectCompleteSecurityEvidence } from './inspection';

const policy = { version: 1 as const, markings: ['GEHEIM'] };
function evidence(): SecurityMarkingEvidence {
  return {
    version: 1,
    coverage: { complete: true, pages: 2, parts: 2 },
    units: [
      { part: 1, page: 1, placement: 'body', text: 'Erste vollständige Seite.' },
      { part: 2, page: 2, placement: 'body', text: '' },
      { part: 2, page: null, placement: 'metadata', text: 'Synthetische Testdaten' },
    ],
  };
}

describe('complete scanner evidence result', () => {
  it('retains actual complete page/part coverage without returning source content or aliases', () => {
    const input = evidence();
    const result = inspectCompleteSecurityEvidence(policy, input);
    expect(result).toEqual({ decision: 'clear', coverage: { complete: true, pages: 2, parts: 2 } });
    input.coverage.pages = 4;
    expect(result).toEqual({ decision: 'clear', coverage: { complete: true, pages: 2, parts: 2 } });
  });

  it('never copies different coverage after the classifier has validated the evidence', () => {
    const input = evidence();
    let reads = 0;
    const changing = new Proxy(input, {
      get(target, key, receiver) {
        if (key === 'coverage' && ++reads > 1) {
          return { complete: true, pages: 500, parts: 2048 };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = inspectCompleteSecurityEvidence(policy, changing);
    if (result.decision === 'clear') {
      expect(result.coverage).toEqual({ complete: true, pages: 2, parts: 2 });
    } else {
      expect(result).toEqual({ decision: 'uninspectable', reason: 'invalid_content' });
    }
  });

  it.each(['coverage', 'pages'] as const)('refuses a %s accessor without invoking it', (key) => {
    const input = evidence();
    const getter = jest.fn(() => {
      throw new Error('Untrusted accessor');
    });
    Object.defineProperty(key === 'coverage' ? input : input.coverage, key, {
      get: getter,
      enumerable: true,
    });
    expect(inspectCompleteSecurityEvidence(policy, input)).toEqual({
      decision: 'uninspectable',
      reason: 'invalid_content',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['page', 'part', 'complete'] as const)(
    'keeps missing %s coverage closed instead of manufacturing a positive result',
    (missing) => {
      const input = evidence();
      if (missing === 'page') input.coverage.pages = 3;
      if (missing === 'part') input.coverage.parts = 3;
      if (missing === 'complete') input.coverage.complete = false;
      expect(inspectCompleteSecurityEvidence(policy, input)).toEqual({
        decision: 'uninspectable',
        reason: 'incomplete_coverage',
      });
    },
  );

  it('preserves classification on a later page and ambiguity without exposing coverage as approval', () => {
    const input = evidence();
    input.units = [input.units[0], { part: 2, page: 2, placement: 'heading', text: 'GEHEIM' }];
    expect(inspectCompleteSecurityEvidence(policy, input)).toEqual({
      decision: 'rejected',
      reason: 'classification_marking',
    });
    input.units = [
      input.units[0],
      { part: 2, page: 2, placement: 'body', text: 'Ein Hinweis auf GEHEIM.' },
    ];
    expect(inspectCompleteSecurityEvidence(policy, input)).toEqual({
      decision: 'uninspectable',
      reason: 'ambiguous_marking',
    });
  });
});
