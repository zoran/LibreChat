const rules = require('./rules.json');
const { LIMITS } = require('./cache');

// Producer catalogue -> the sole public DTO keys. Raw labels, URLs and PromQL stay server-side.
const KEYS = Object.freeze({
  cpu_utilization_ratio: 'cpu.utilization',
  memory_available_bytes: 'memory.available',
  memory_available_ratio: 'memory.available_ratio',
  pressure_cpu_waiting_ratio: 'pressure.cpu_waiting',
  pressure_io_waiting_ratio: 'pressure.io_waiting',
  pressure_io_stalled_ratio: 'pressure.io_stalled',
  pressure_memory_waiting_ratio: 'pressure.memory_waiting',
  pressure_memory_stalled_ratio: 'pressure.memory_stalled',
  filesystem_available_bytes: 'filesystem.available',
  filesystem_available_ratio: 'filesystem.available_ratio',
  filesystem_inodes_free: 'filesystem.inodes_free',
  filesystem_inodes_free_ratio: 'filesystem.inodes_free_ratio',
  network_receive_bytes_rate: 'network.rx',
  network_receive_drop_rate: 'network.rx_drops',
  network_receive_errs_rate: 'network.rx_errors',
  network_transmit_bytes_rate: 'network.tx',
  network_transmit_drop_rate: 'network.tx_drops',
  network_transmit_errs_rate: 'network.tx_errors',
  gpu_utilization_ratio: 'gpu.utilization',
  gpu_memory_used_bytes: 'gpu.memory_used',
  gpu_power_watts: 'gpu.power',
  http_requests_rate: 'http.request_rate',
  http_latency_p95_seconds: 'http.latency_p95',
});
const SERIES = new Map(
  Object.entries(rules.catalog).flatMap(([key, item]) =>
    ['series', 'sourceTimeSeries', 'sampleCountSeries', 'resetsSeries'].map((field) => [
      item[field],
      { key, field, item },
    ]),
  ),
);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value, keys) =>
  plain(value) && Object.keys(value).every((key) => keys.includes(key));
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const recent = (value, now, age) => {
  const time = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return finite(time) && time <= now && now - time <= age;
};
function body(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.observerBytes)
    throw Error('STATUS_OBSERVER_BOUND');
  const value = JSON.parse(bytes.toString('utf8'));
  if (
    !keysWithin(value, ['status', 'data', 'warnings', 'infos']) ||
    value.status !== 'success' ||
    (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length)) ||
    (value.infos !== undefined && (!Array.isArray(value.infos) || value.infos.length))
  )
    throw Error('STATUS_OBSERVER_UNKNOWN');
  return value.data;
}
function healthy(bytes, now) {
  const data = body(bytes);
  if (
    !keysWithin(data, ['groups']) ||
    !Array.isArray(data.groups) ||
    data.groups.length !== rules.groups.length
  )
    return false;
  const actual = new Map(data.groups.map((group) => [group.name, group]));
  if (actual.size !== rules.groups.length) return false;
  return rules.groups.every((expected) => {
    const group = actual.get(expected.name);
    if (
      !keysWithin(group, [
        'name',
        'file',
        'rules',
        'interval',
        'limit',
        'evaluationTime',
        'lastEvaluation',
      ]) ||
      group.file !== rules.ruleFile ||
      group.interval !== expected.intervalSeconds ||
      group.limit !== expected.limit ||
      !recent(group.lastEvaluation, now, rules.healthMaxAgeSeconds) ||
      !Array.isArray(group.rules) ||
      group.rules.length !== expected.rules.length
    )
      return false;
    const names = new Set();
    return group.rules.every((rule) => {
      if (
        !keysWithin(rule, [
          'name',
          'query',
          'labels',
          'health',
          'lastError',
          'evaluationTime',
          'lastEvaluation',
          'type',
        ]) ||
        names.has(rule.name) ||
        !expected.rules.includes(rule.name) ||
        rule.type !== 'recording' ||
        rule.health !== 'ok' ||
        (rule.lastError !== undefined && rule.lastError !== '') ||
        !recent(rule.lastEvaluation, now, rules.healthMaxAgeSeconds) ||
        typeof rule.query !== 'string' ||
        !rule.query.length ||
        rule.query.length > 16384 ||
        rule.query !== expected.expressions[rule.name]?.query ||
        !plain(rule.labels) ||
        Object.keys(rule.labels).length !== 0
      )
        return false;
      names.add(rule.name);
      return true;
    });
  });
}
function healthDeadline(bytes, now) {
  if (!healthy(bytes, now)) return null;
  const data = body(bytes);
  return (
    Math.min(
      ...data.groups
        .flatMap((group) => [
          group.lastEvaluation,
          ...group.rules.map((rule) => rule.lastEvaluation),
        ])
        .map((time) => Date.parse(time) / 1000),
    ) + rules.healthMaxAgeSeconds
  );
}
function readRows(bytes, now) {
  const data = body(bytes);
  if (
    !keysWithin(data, ['resultType', 'result']) ||
    data.resultType !== 'vector' ||
    !Array.isArray(data.result) ||
    data.result.length > 8192
  )
    throw Error('STATUS_OBSERVER_UNKNOWN');
  const rows = new Map();
  const counts = new Map();
  for (const sample of data.result) {
    if (!keysWithin(sample, ['metric', 'value']) || !plain(sample.metric))
      throw Error('STATUS_OBSERVER_UNKNOWN');
    const definition = SERIES.get(sample.metric.__name__);
    if (
      !definition ||
      !keysWithin(sample.metric, ['__name__', ...definition.item.dimensions]) ||
      Object.values(sample.metric).some(
        (value) => typeof value !== 'string' || value.length > 512,
      ) ||
      !sample.metric.node ||
      !sample.metric.job ||
      !sample.metric.instance ||
      !Array.isArray(sample.value) ||
      sample.value.length !== 2 ||
      !finite(sample.value[0]) ||
      sample.value[0] > now ||
      typeof sample.value[1] !== 'string' ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(sample.value[1])
    )
      throw Error('STATUS_OBSERVER_UNKNOWN');
    const value = Number(sample.value[1]);
    if (!finite(value)) throw Error('STATUS_OBSERVER_UNKNOWN');
    const count = (counts.get(sample.metric.__name__) ?? 0) + 1;
    if (count > definition.item.maximumSeries) throw Error('STATUS_OBSERVER_BOUND');
    counts.set(sample.metric.__name__, count);
    const labels = Object.fromEntries(
      definition.item.dimensions.map((key) => [key, sample.metric[key] ?? '']),
    );
    const id = JSON.stringify([definition.key, labels]);
    const row = rows.get(id) ?? {
      key: KEYS[definition.key],
      labels,
      definition: definition.item,
      fields: {},
    };
    if (row.fields[definition.field] !== undefined) throw Error('STATUS_OBSERVER_DUPLICATE');
    row.fields[definition.field] = { value, evaluatedAt: sample.value[0] };
    rows.set(id, row);
  }
  return [...rows.values()];
}
function matches(measurement, node, row, parents) {
  if (measurement.key !== row.key || measurement.target.kind !== 'node') return false;
  const scope = measurement.scope,
    labels = row.labels;
  if (scope.kind === 'gpu')
    return node.identity.key === labels.UUID && parents.get(node.id) === labels.node;
  if (scope.kind === 'http')
    return (
      node.identity.key === labels.pod_uid &&
      scope.instanceId === labels.pod_uid &&
      scope.method === labels.method &&
      scope.routeKey === labels.path &&
      String(scope.statusCode) === labels.status
    );
  if (node.identity.key !== labels.node) return false;
  if (scope.kind === 'cpu') return scope.cpuId === labels.cpu;
  if (scope.kind === 'filesystem')
    return (
      scope.deviceId === labels.device &&
      scope.mountId === labels.mountpoint &&
      scope.fsType === labels.fstype
    );
  if (scope.kind === 'interface') return scope.interfaceId === labels.device;
  return scope.kind === 'host';
}
function sampleFor(measurement, node, observer, parents, now) {
  const matchesRows = observer.rows.filter((row) => matches(measurement, node, row, parents));
  if (matchesRows.length !== 1) return { reason: 'not_measured' };
  const { fields: f, definition } = matchesRows[0];
  if (!['series', 'sourceTimeSeries', 'sampleCountSeries', 'resetsSeries'].every((key) => f[key]))
    return { reason: 'insufficient_samples' };
  if (
    new Set(Object.values(f).map((value) => value.evaluatedAt)).size !== 1 ||
    f.sourceTimeSeries.value > now ||
    f.sourceTimeSeries.value > observer.receivedAt ||
    f.sourceTimeSeries.value > f.series.evaluatedAt
  )
    return { reason: 'not_measured' };
  if (f.resetsSeries.value !== 0) return { reason: 'counter_reset' };
  if (
    !Number.isSafeInteger(f.sampleCountSeries.value) ||
    f.sampleCountSeries.value < (definition.windowSeconds ? 4 : 1) ||
    f.sampleCountSeries.value > 1000000
  )
    return { reason: 'insufficient_samples' };
  if (
    (definition.unit === 'ratio' && f.series.value > 1) ||
    (definition.unit === 'count' && !Number.isInteger(f.series.value))
  )
    return { reason: 'not_measured' };
  return {
    sample: {
      sourceId: observer.sourceId,
      observedAt: f.sourceTimeSeries.value,
      value: f.series.value,
      windowSeconds: definition.windowSeconds,
      sampleCount: f.sampleCountSeries.value,
      resetCount: 0,
      coverage: { expected: 1, observed: 1 },
    },
  };
}
function createProjector({ readStatusSnapshot, STATUS_METRICS }) {
  function checked(value) {
    const result = readStatusSnapshot(value);
    if (!result) throw Error('STATUS_DTO_INVALID');
    return result;
  }
  function age(value, now) {
    const snapshot = checked(value);
    if (!finite(now) || now < snapshot.generatedAt) throw Error('STATUS_CLOCK_INVALID');
    snapshot.generatedAt = now;
    for (const parameter of snapshot.parameters)
      if (
        parameter.state === 'known' &&
        parameter.stage !== 'proposed' &&
        parameter.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds)
      )
        parameter.state = 'stale';
    for (const item of [...snapshot.edges, ...snapshot.nodes.flatMap((node) => node.assessments)]) {
      if (
        ['healthy', 'degraded'].includes(item.state) &&
        item.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds)
      ) {
        item.state = 'stale';
        item.reason = 'source_stale';
      }
    }
    for (const measurement of snapshot.measurements)
      if (measurement.state === 'fresh') {
        const selected = measurement.samples.find(
          (sample) => sample.sourceId === measurement.selectedSourceId,
        );
        if (now - selected.observedAt > STATUS_METRICS[measurement.key].maxAgeSeconds) {
          measurement.state = 'stale';
          measurement.reason = 'source_stale';
        }
      }
    return checked(snapshot);
  }
  function project(seed, responses, now) {
    const snapshot = age(seed, now);
    if (
      snapshot.sources.some((source) => source.kind === 'prometheus') ||
      snapshot.selectedObserverId !== null ||
      snapshot.measurements.some((measurement) => measurement.samples.length)
    )
      throw Error('STATUS_TOPOLOGY_NOT_STATIC');
    const observers = [];
    for (const response of responses) {
      if (!response || !finite(response.receivedAt) || response.receivedAt > now) continue;
      try {
        if (
          response.projection.length + response.ruleHealth.length > LIMITS.observerBytes ||
          !healthy(response.ruleHealth, now)
        )
          continue;
        observers.push({
          ...response,
          sourceId: `prometheus-${response.observerId}`,
          rows: readRows(response.projection, now),
        });
      } catch {
        /* Malformed, paginated, stale or ambiguous producer remains unavailable. */
      }
    }
    const selected = observers.find((observer) => observer.rows.length) ?? observers[0];
    snapshot.selectedObserverId = selected?.observerId ?? null;
    snapshot.sources.push(
      ...observers.map((observer) => ({
        id: observer.sourceId,
        kind: 'prometheus',
        observerId: observer.observerId,
        capturedAt: observer.receivedAt,
      })),
    );
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const parents = new Map(
      snapshot.edges
        .filter((edge) => edge.kind === 'contains' && edge.basis === 'desired')
        .map((edge) => [edge.to, nodes.get(edge.from)?.identity.key]),
    );
    for (const measurement of snapshot.measurements) {
      if (measurement.state === 'disabled') continue;
      Object.assign(measurement, { value: null, selectedSourceId: null, samples: [] });
      if (!selected) {
        measurement.state = 'unavailable';
        measurement.reason = 'source_unavailable';
        continue;
      }
      const node = nodes.get(measurement.target.id);
      const chosen = sampleFor(measurement, node, selected, parents, now);
      if (!chosen.sample) {
        measurement.state = 'unknown';
        measurement.reason = chosen.reason;
        continue;
      }
      const other = observers.find((observer) => observer !== selected);
      const alternate = other
        ? sampleFor(measurement, node, other, parents, now).sample
        : undefined;
      measurement.samples = alternate ? [chosen.sample, alternate] : [chosen.sample];
      if (
        alternate &&
        (alternate.value !== chosen.sample.value ||
          alternate.observedAt !== chosen.sample.observedAt)
      ) {
        measurement.state = 'disagreement';
        measurement.reason = 'sources_disagree';
        continue;
      }
      measurement.value = chosen.sample.value;
      measurement.selectedSourceId = selected.sourceId;
      measurement.state =
        now - chosen.sample.observedAt > STATUS_METRICS[measurement.key].maxAgeSeconds
          ? 'stale'
          : 'fresh';
      measurement.reason = measurement.state === 'stale' ? 'source_stale' : 'observed';
    }
    return checked(snapshot);
  }
  return { age, project };
}
module.exports = { createProjector, healthy, healthDeadline, readRows, KEYS };
