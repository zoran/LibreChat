import {
  STATUS_PARAMETERS,
  readStatusSnapshot as readWireStatusSnapshot,
  encodeStatusSnapshot,
  type StatusSnapshot,
  STATUS_LIMITS,
  STATUS_METRICS,
  STATUS_ZOOM_PRESETS,
} from './status';
import representative from './status-fixtures/representative.json';
import degraded from './status-fixtures/degraded.json';

// Coherence mutation tests operate on the decoded model and explicitly re-encode.
// The externally exposed reader remains wire-only.
const readStatusSnapshot = (value: unknown): StatusSnapshot | null => {
  try {
    const m = (value as { measurements?: unknown[] })?.measurements;
    return readWireStatusSnapshot(
      m?.length && !Array.isArray(m[0]) ? encodeStatusSnapshot(value as StatusSnapshot) : value,
    );
  } catch {
    return null;
  }
};
const fresh = (): StatusSnapshot =>
  JSON.parse(JSON.stringify(readWireStatusSnapshot(representative)));

describe('one Cortex Status snapshot contract', () => {
  test('one graph preserves many-to-many allocation and zero traffic across all presets', () => {
    const result = readStatusSnapshot(representative)!;
    expect(result).not.toBeNull();
    expect(STATUS_ZOOM_PRESETS).toEqual(['overview', 'infrastructure', 'processing']);
    const gpus = result.nodes.filter(
      (n) => n.identity.scope === 'physical' && n.identity.kind === 'gpu',
    );
    expect(gpus).toHaveLength(3);
    const allocations = result.edges.filter((e) => e.kind === 'allocation');
    expect(allocations.filter((e) => e.to === gpus[1].id)).toHaveLength(4);
    expect(allocations.filter((e) => e.from === 'runtime:pod:ds-b')).toHaveLength(2);
    expect(result.measurements.find((m) => m.key === 'network.rx')).toMatchObject({
      state: 'fresh',
      value: 0,
    });
    expect(result.measurements.find((m) => m.target.id === 'runtime:pod:embedder-1')).toMatchObject(
      { state: 'unknown', value: null },
    );
    expect(Object.keys(STATUS_METRICS)).toHaveLength(23);
  });

  test('stale, unknown, disabled, unavailable and observer disagreement stay distinct', () => {
    const result = readStatusSnapshot(degraded)!;
    expect(result).not.toBeNull();
    expect(result.measurements[0]).toMatchObject({ state: 'stale', value: 0.25 });
    expect(result.measurements[1]).toMatchObject({
      state: 'disagreement',
      value: null,
      selectedSourceId: null,
    });
    expect(result.measurements[1].samples.map((s) => s.value)).toEqual([64000000000, 32000000000]);
    expect(result.measurements[2]).toMatchObject({ state: 'unavailable', value: null });
    expect(result.measurements[5]).toMatchObject({ state: 'disabled', value: null });
  });

  test.each([
    [
      'duplicate physical identity',
      (s: ReturnType<typeof fresh>) => {
        s.nodes.push({ ...s.nodes[2], id: 'alias' });
      },
    ],
    [
      'duplicate allocation',
      (s: ReturnType<typeof fresh>) => {
        s.edges.push({ ...s.edges[15], id: 'duplicate' });
      },
    ],
    [
      'old runtime placement claimed healthy',
      (s: ReturnType<typeof fresh>) => {
        s.edges[15].evidence[0].observedAt -= 100;
      },
    ],
    [
      'desired relation claimed observed healthy',
      (s: ReturnType<typeof fresh>) => {
        s.edges[21].state = 'healthy';
      },
    ],
    [
      'dangling edge',
      (s: ReturnType<typeof fresh>) => {
        s.edges[0].to = 'missing';
      },
    ],
    [
      'GPU assignment from inventory only',
      (s: ReturnType<typeof fresh>) => {
        s.edges[15].evidence[0].sourceId = 'inventory';
      },
    ],
    [
      'unknown zero',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[7].value = 0;
      },
    ],
    [
      'nonfinite number',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].value = Infinity;
      },
    ],
    [
      'ratio above one',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].value = 2;
        s.measurements[0].samples[0].value = 2;
      },
    ],
    [
      'wrong unit',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].unit = 'bytes';
      },
    ],
    [
      'host CPU average without core census',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].scope = { kind: 'host' };
      },
    ],
    [
      'counter reset hidden as current rate',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].samples[0].resetCount = 1;
      },
    ],
    [
      'insufficient source samples',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].samples[0].sampleCount = 3;
      },
    ],
    [
      'future original sample',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].samples[0].observedAt = s.generatedAt + 1;
      },
    ],
    [
      'fresh label on old sample',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].samples[0].observedAt -= 100;
      },
    ],
    [
      'mixed selected observers',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].selectedSourceId = 'cpu3';
        s.measurements[0].samples[0].sourceId = 'cpu3';
      },
    ],
    [
      'HA sum masquerading as sample',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].value = 0.5;
      },
    ],
    [
      'NIC totals attributed to App link',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[2].target = { kind: 'edge', id: s.edges[21].id };
      },
    ],
    [
      'endpoint HTTP counter attributed to caller link',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[6].target = { kind: 'edge', id: s.edges[21].id };
      },
    ],
    [
      'runtime mismatch',
      (s: ReturnType<typeof fresh>) => {
        (
          s.measurements[6].scope as Extract<
            StatusSnapshot['measurements'][number]['scope'],
            { kind: 'http' }
          >
        ).instanceId = 'different-pod';
      },
    ],
    [
      'coverage claim exceeds census',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].samples[0].coverage.observed = 2;
      },
    ],
    [
      'partial coverage called complete',
      (s: ReturnType<typeof fresh>) => {
        s.measurements[0].samples[0].coverage.expected = 2;
      },
    ],
    [
      'metric source claimed as App-E2E proof',
      (s: ReturnType<typeof fresh>) => {
        Object.assign(s.nodes[0], {
          assessments: [
            {
              dimension: 'app_e2e',
              state: 'healthy',
              reason: 'observed',
              evidence: s.edges[0].evidence,
            },
          ],
        });
      },
    ],
    [
      'new UI-specific graph contract',
      (s: ReturnType<typeof fresh>) => {
        Object.assign(s, { preset: 'infrastructure' });
      },
    ],
    [
      'raw PromQL field',
      (s: ReturnType<typeof fresh>) => {
        Object.assign(s, { query: 'up' });
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const input = fresh();
    mutate(input);
    expect(readStatusSnapshot(input)).toBeNull();
  });

  test('actual partial coverage is representable without inventing the missing value', () => {
    const input = fresh();
    input.measurements[0].samples[0].coverage.expected = 2;
    input.measurements[0].reason = 'partial_coverage';
    expect(readStatusSnapshot(input)?.measurements[0].samples[0].coverage).toEqual({
      expected: 2,
      observed: 1,
    });
  });

  test('equivalent HA samples are preserved once, never added', () => {
    const input = fresh();
    Object.assign(input.measurements[0], {
      samples: [
        ...input.measurements[0].samples,
        { ...input.measurements[0].samples[0], sourceId: 'cpu3' },
      ],
    });
    expect(readStatusSnapshot(input)?.measurements[0].value).toBe(0.25);
    input.measurements[0].samples[1].value = 0.2;
    expect(readStatusSnapshot(input)).toBeNull();
  });

  test('detaches data, rejects getters without invoking them, cycles and excess graph size', () => {
    const input = fresh();
    const result = readStatusSnapshot(input)!;
    input.nodes[0].label = 'changed';
    expect(result.nodes[0].label).toBe('GPU-Server A');
    const getter = jest.fn(() => 1);
    const bad = fresh();
    Object.defineProperty(bad, 'version', { enumerable: true, get: getter });
    expect(readStatusSnapshot(bad)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    Object.assign(bad, { nodes: bad });
    expect(readStatusSnapshot(bad)).toBeNull();
    const large = fresh();
    large.nodes = Array(STATUS_LIMITS.maxNodes + 1).fill(large.nodes[0]);
    expect(readStatusSnapshot(large)).toBeNull();
  });
});

describe('review regressions and source-bound settings', () => {
  test.each(['node', 'edge'])('rejects healthy with source-unavailable reason on %s', (kind) => {
    const v = fresh();
    if (kind === 'node')
      Object.assign(v.nodes[0], {
        assessments: [
          {
            dimension: 'availability',
            ...v.edges[0],
            state: 'healthy',
            reason: 'source_unavailable',
            evidence: v.edges[0].evidence,
          },
        ],
      });
    else v.edges[0].reason = 'source_unavailable';
    // Construct only the actual assessment fields, so rejection tests state/reason coherence.
    if (kind === 'node')
      Object.assign(v.nodes[0], {
        assessments: [
          {
            dimension: 'availability',
            state: 'healthy',
            reason: 'source_unavailable',
            evidence: v.edges[0].evidence,
          },
        ],
      });
    expect(readStatusSnapshot(v)).toBeNull();
  });
  test('one physical GPU has one current host while desired/stale/conflicting history remains explicit', () => {
    const v = fresh();
    const extra = { ...v.edges[0], id: 'other-host', from: v.nodes[1].id };
    v.edges.push(extra);
    expect(readStatusSnapshot(v)).toBeNull();
    extra.state = 'stale';
    extra.reason = 'source_stale';
    extra.evidence = [{ ...extra.evidence[0], observedAt: v.generatedAt - 100 }];
    expect(readStatusSnapshot(v)).not.toBeNull();
    extra.state = 'unknown';
    extra.reason = 'not_measured';
    extra.basis = 'desired';
    extra.evidence = [{ ...extra.evidence[0], sourceId: 'inventory' }];
    expect(readStatusSnapshot(v)).not.toBeNull();
    extra.state = 'disagreement';
    extra.reason = 'sources_disagree';
    extra.basis = 'observed';
    extra.evidence = [v.edges[0].evidence[0], { ...v.edges[0].evidence[0], sourceId: 'inventory' }];
    expect(readStatusSnapshot(v)).not.toBeNull();
  });
  test('shows configured and proposed values with immutable decision provenance, effective stays unknown', () => {
    const v = readStatusSnapshot(representative)!;
    expect(v.parameters.map((p) => [p.stage, p.state, p.value])).toEqual([
      ['configured', 'known', 393216],
      ['proposed', 'known', 8192],
      ['effective', 'unknown', null],
      ['configured', 'unknown', null],
      ['proposed', 'known', 768],
    ]);
    expect(v.parameterEvidence[0]).toMatchObject({
      kind: 'decision',
      timeBasis: 'source_capture',
      parameterKey: 'inference.context_tokens',
    });
    expect(Object.keys(STATUS_PARAMETERS)).toHaveLength(40);
    expect(readStatusSnapshot(degraded)?.parameters[0].state).toBe('stale');
  });
  test.each([
    [
      'reason without actual reference',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].reason.evidenceIds = [];
      },
    ],
    [
      'reference to another component',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].reason.evidenceIds = [v.parameterEvidence[1].id];
      },
    ],
    [
      'reference for another setting',
      (v: ReturnType<typeof fresh>) => {
        v.parameterEvidence[0].parameterKey = 'embedding.dimension';
      },
    ],
    [
      'raw path reason',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].reason.text = '/srv/private/file';
      },
    ],
    [
      'secret URL reason',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].reason.text = 'https://secret.invalid';
      },
    ],
    [
      'unknown parameter key',
      (v: ReturnType<typeof fresh>) => {
        (v.parameters[0] as { key: string }).key = 'environment.API_KEY';
      },
    ],
    [
      'unregistered enum',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[3].state = 'known';
        Object.assign(v.parameters[3], { value: 'private-secret' });
        v.parameters[3].evidence = v.parameters[0].evidence;
      },
    ],
    [
      'effective from config only',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].nodeId = 'runtime:pod:ds-a';
        v.parameters[0].stage = 'effective';
      },
    ],
    [
      'effective model-wide claim',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].stage = 'effective';
      },
    ],
    [
      'unknown with hidden value',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[2].value = 128000;
      },
    ],
    [
      'proposed without documented rationale',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[1].reason = { state: 'unknown', text: null, evidenceIds: [] };
      },
    ],
    [
      'nonfinite parameter',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].value = NaN;
      },
    ],
    [
      'fractional token count',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].value = 1.5;
      },
    ],
    [
      'duplicate parameter stage',
      (v: ReturnType<typeof fresh>) => {
        v.parameters.push(v.parameters[0]);
      },
    ],
    [
      'invented edge purpose',
      (v: ReturnType<typeof fresh>) => {
        v.edges[0].purpose = 'model_request';
      },
    ],
    [
      'too many settings',
      (v: ReturnType<typeof fresh>) => {
        v.parameters = Array(513).fill(v.parameters[0]);
      },
    ],
    [
      'oversized rationale',
      (v: ReturnType<typeof fresh>) => {
        v.parameters[0].reason.text = 'x'.repeat(241);
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const v = fresh();
    mutate(v);
    expect(readStatusSnapshot(v)).toBeNull();
  });
  test('unknown selection reason is permitted for a genuinely configured value', () => {
    const v = fresh();
    v.parameters[0].reason = { state: 'unknown', text: null, evidenceIds: [] };
    expect(readStatusSnapshot(v)).not.toBeNull();
  });
});

test('effective runtime setting is distinct and expires by original evidence', () => {
  const v = fresh();
  const p = v.parameters[2];
  p.state = 'known';
  p.value = 393216;
  p.evidence = [v.edges[0].evidence[0]];
  expect(readStatusSnapshot(v)?.parameters[2]).toMatchObject({
    stage: 'effective',
    state: 'known',
    value: 393216,
  });
  p.evidence = [{ ...p.evidence[0], observedAt: v.generatedAt - 100 }];
  expect(readStatusSnapshot(v)).toBeNull();
  p.state = 'stale';
  expect(readStatusSnapshot(v)).not.toBeNull();
});
test('enforces per-node parameter count and evidence capture kind', () => {
  const v = fresh();
  v.parameters = Object.entries(STATUS_PARAMETERS)
    .slice(0, 25)
    .map(([key, d]) => ({
      nodeId: 'logical:service:deepseek',
      key: key as keyof typeof STATUS_PARAMETERS,
      label: d.label,
      unit: d.unit,
      stage: 'configured',
      state: 'unknown',
      value: null,
      evidence: [],
      reason: { state: 'unknown', text: null, evidenceIds: [] },
    }));
  expect(readStatusSnapshot(v)).toBeNull();
  v.parameters.pop();
  expect(readStatusSnapshot(v)).not.toBeNull();
  v.parameterEvidence[0].timeBasis = 'benchmark_run';
  expect(readStatusSnapshot(v)).toBeNull();
});

describe('v2 inventory classifications and orchestration boundaries', () => {
  const current = () => readStatusSnapshot(representative)!;
  test('one graph carries desired roles independently of unknown health and runtime placement', () => {
    const s = current();
    expect(s.version).toBe(3);
    const cpu = s.nodes.find((n) => n.id === 'physical:host:control-a')!;
    expect(cpu.classification).toMatchObject({
      kind: 'server',
      role: 'cpu',
      basis: 'desired',
      state: 'known',
    });
    expect(cpu.assessments[0].state).toBe('unknown');
    expect(s.nodes.filter((n) => n.classification?.kind === 'kubernetes')).toHaveLength(9);
    expect(
      s.edges.find((e) => e.from === cpu.id && e.kind === 'membership')?.membershipRoles,
    ).toEqual(['control_plane', 'etcd']);
    expect(
      s.edges
        .filter((e) => e.kind === 'placement')
        .every((e) => e.basis === 'desired' && e.state === 'unknown'),
    ).toBe(true);
    cpu.classification = null;
    cpu.label = 'GPU-123';
    expect(readStatusSnapshot(s)?.nodes.find((n) => n.id === cpu.id)?.classification).toBeNull();
    expect(readStatusSnapshot({ ...s, version: 1 })).toBeNull();
  });

  test.each([
    [
      'missing required classification',
      (s: ReturnType<typeof fresh>) => {
        Reflect.deleteProperty(s.nodes[0], 'classification');
      },
    ],
    [
      'hostname-derived role',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[0].classification!.evidence = [];
      },
    ],
    [
      'server role on a GPU device',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[2].classification = s.nodes[0].classification;
      },
    ],
    [
      'observed inventory role',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[0].classification!.basis = 'observed';
      },
    ],
    [
      'wrong source kind',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[0].classification!.evidence[0].sourceId = 'runtime';
      },
    ],
    [
      'uncovered inventory role',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[0].classification!.evidence[0].coverage.observed = 0;
      },
    ],
    [
      'stale evidence called known',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[0].classification!.evidence[0].observedAt -= 86401;
      },
    ],
    [
      'fresh evidence called stale',
      (s: ReturnType<typeof fresh>) => {
        s.nodes[0].classification!.state = 'stale';
      },
    ],
    [
      'duplicate membership role',
      (s: ReturnType<typeof fresh>) => {
        s.edges.find((e) => e.purpose === 'cluster_membership')!.membershipRoles = [
          'worker',
          'worker',
        ];
      },
    ],
    [
      'missing membership role',
      (s: ReturnType<typeof fresh>) => {
        Reflect.deleteProperty(
          s.edges.find((e) => e.purpose === 'cluster_membership')!,
          'membershipRoles',
        );
      },
    ],
    [
      'membership on wrong target',
      (s: ReturnType<typeof fresh>) => {
        s.edges.find((e) => e.purpose === 'cluster_membership')!.to = s.nodes[0].id;
      },
    ],
    [
      'configured placement called observed',
      (s: ReturnType<typeof fresh>) => {
        s.edges.find((e) => e.kind === 'placement')!.basis = 'observed';
      },
    ],
    [
      'configured component called runtime deployment',
      (s: ReturnType<typeof fresh>) => {
        const e = s.edges.find((e) => e.kind === 'placement')!;
        e.kind = 'deployment';
        e.purpose = 'runtime_placement';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const s = fresh();
    mutate(s);
    expect(readStatusSnapshot(s)).toBeNull();
  });
});
