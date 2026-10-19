/** Closed display metadata. No runtime defaults or raw configuration export. */
export const STATUS_PARAMETERS = {
  'inference.context_tokens': {
    label: 'Kontextfenster',
    unit: 'tokens',
    kind: 'integer',
  },
  'inference.max_output_tokens': {
    label: 'Maximale Antwortlänge',
    unit: 'tokens',
    kind: 'integer',
  },
  'inference.request_timeout_seconds': {
    label: 'Anfragefrist',
    unit: 'seconds',
    kind: 'number',
  },
  'inference.tensor_parallel_size': {
    label: 'Tensorparallelität',
    unit: 'count',
    kind: 'integer',
  },
  'inference.pipeline_parallel_size': {
    label: 'Pipelineparallelität',
    unit: 'count',
    kind: 'integer',
  },
  'inference.max_sequences': {
    label: 'Gleichzeitige Sequenzen',
    unit: 'count',
    kind: 'integer',
  },
  'inference.batch_tokens': {
    label: 'Tokens je Batch',
    unit: 'tokens',
    kind: 'integer',
  },
  'inference.gpu_memory_fraction': {
    label: 'GPU-Speicheranteil',
    unit: 'ratio',
    kind: 'number',
  },
  'inference.reasoning_effort': {
    label: 'Reasoning-Aufwand',
    unit: 'count',
    kind: 'integer',
  },
  'inference.eager': {
    label: 'Eager-Ausführung',
    unit: 'boolean',
    kind: 'boolean',
  },
  'inference.prefix_cache': {
    label: 'Prefixcache',
    unit: 'boolean',
    kind: 'boolean',
  },
  'inference.engram_cpu_offload': {
    label: 'Engram auf CPU',
    unit: 'boolean',
    kind: 'boolean',
  },
  'inference.runner': {
    label: 'Runner',
    unit: 'none',
    kind: 'enum',
    values: ['vllm', 'vllm_v1', 'vllm_pooling'],
  },
  'inference.weight_quantization': {
    label: 'Gewichtsquantisierung',
    unit: 'none',
    kind: 'enum',
    values: ['none', 'int8_per_channel_weight_only'],
  },
  'inference.kv_dtype': {
    label: 'KV-Cache-Format',
    unit: 'none',
    kind: 'enum',
    values: ['fp8_ds_mla'],
  },
  'inference.compute_dtype': {
    label: 'Rechenpräzision',
    unit: 'none',
    kind: 'enum',
    values: ['bfloat16', 'float32'],
  },
  'ocr.ngram_size': {
    label: 'N-Gram-Länge',
    unit: 'tokens',
    kind: 'integer',
  },
  'ocr.ngram_window': {
    label: 'N-Gram-Fenster',
    unit: 'tokens',
    kind: 'integer',
  },
  'embedding.dimension': {
    label: 'Embeddingdimension',
    unit: 'count',
    kind: 'integer',
  },
  'embedding.pooling': {
    label: 'Embedding-Pooling',
    unit: 'none',
    kind: 'enum',
    values: ['MEAN'],
  },
  'reranker.pooling': {
    label: 'Reranker-Pooling',
    unit: 'none',
    kind: 'enum',
    values: ['LAST'],
  },
  'reranker.score_method': {
    label: 'Reranker-Score',
    unit: 'none',
    kind: 'enum',
    values: ['from_2_way_softmax'],
  },
  'cpu.interop_threads': {
    label: 'Interop-Threads',
    unit: 'count',
    kind: 'integer',
  },
  'cpu.worker_threads': {
    label: 'Worker-Threads',
    unit: 'count',
    kind: 'integer',
  },
  'cpu.worker_kv_bytes': {
    label: 'KV-Budget je Worker',
    unit: 'bytes',
    kind: 'integer',
  },
  'rag.lexical_candidates': {
    label: 'Lexikalische Kandidaten',
    unit: 'count',
    kind: 'integer',
  },
  'rag.dense_candidates': {
    label: 'Semantische Kandidaten',
    unit: 'count',
    kind: 'integer',
  },
  'rag.visual_candidates': {
    label: 'Visuelle Kandidaten',
    unit: 'count',
    kind: 'integer',
  },
  'rag.unique_candidates': {
    label: 'Eindeutige Kandidaten',
    unit: 'count',
    kind: 'integer',
  },
  'rag.rerank_candidates': {
    label: 'Reranking-Kandidaten',
    unit: 'count',
    kind: 'integer',
  },
  'rag.chunk_target_min_tokens': {
    label: 'Chunkziel Untergrenze',
    unit: 'tokens',
    kind: 'integer',
  },
  'rag.chunk_target_max_tokens': {
    label: 'Chunkziel Obergrenze',
    unit: 'tokens',
    kind: 'integer',
  },
  'rag.chunk_cap_tokens': {
    label: 'Maximale Chunklänge',
    unit: 'tokens',
    kind: 'integer',
  },
  'rag.pool_connections': {
    label: 'DB-Poolverbindungen',
    unit: 'count',
    kind: 'integer',
  },
  'connection.provider_timeout_seconds': {
    label: 'Providerfrist',
    unit: 'seconds',
    kind: 'number',
  },
  'connection.guard_read_timeout_seconds': {
    label: 'Guard-Lesefrist',
    unit: 'seconds',
    kind: 'number',
  },
  'connection.guard_send_timeout_seconds': {
    label: 'Guard-Sendefrist',
    unit: 'seconds',
    kind: 'number',
  },
  'rag.lock_timeout_seconds': {
    label: 'SQL-Lockfrist',
    unit: 'seconds',
    kind: 'number',
  },
  'rag.statement_timeout_seconds': {
    label: 'SQL-Statementfrist',
    unit: 'seconds',
    kind: 'number',
  },
  'rag.idle_transaction_timeout_seconds': {
    label: 'Inaktive Transaktionsfrist',
    unit: 'seconds',
    kind: 'number',
  },
} as const;
export type StatusParameterKey = keyof typeof STATUS_PARAMETERS;
