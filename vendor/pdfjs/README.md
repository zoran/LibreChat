# PDF.js 5.4.624 Cortex metadata.2 derivative

This directory preserves the qualified `pdfjs-dist` archive and its source patch. Preserve these files together in an immutable repository commit before adopting an exact commit-based dependency pin. Adding these files alone does not change the application's installed PDF.js package.

The upstream source is [Mozilla PDF.js commit 384c6208b257e81fa7bcd4e59dc100e3c99d9528](https://github.com/mozilla/pdf.js/tree/384c6208b257e81fa7bcd4e59dc100e3c99d9528), version **5.4.624**. The derivative is **5.4.624-cortex.metadata.2**, with API/worker build identity **384c6208b-cortex.metadata.2** and release build number **624**. Both modern and legacy API/worker pairs belong to this exact distribution.

The changes add opt-in bounded catalog-metadata evidence through `strictMetadata` and propagate strict image failures through the existing `stopAtErrors` behavior, including asynchronous decoding, cached failures and repeated or concurrent page consumers. Default tolerant behavior is retained. The metadata contract always reports `documentComplete: false`; successful catalog inspection is not complete document approval. `getMetadata().metadata` is correctly typed as `Metadata | null`.

## Immutable files

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `pdfjs-dist-5.4.624-cortex.metadata.2.tgz` | 9,997,563 | `a10310c756e6dbc119bd1f03d968639b87e11d1e53da29eea5e1d87249039d71` |
| `pdfjs-5.4.624-cortex.metadata.2-source.patch` | 43,733 | `0cb01de09ada6ccc95b6302ac5557859908e8ef9d154db4e6ef50108b2a104c6` |
| `LICENSE` | 10,174 | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `MODIFICATIONS.md` | 2,053 | `da4892645248fa5fe14713a66de1ccd5be1baf6b5cc5caa60d002f6cc67af8c7` |

Archive npm integrity:

```text
sha512-rEbYgIPdtvJ9fKPnKKapdjRuZPW0Ql/gJYX27PquknUep7QWThRgs8gt3P8mcXfDuov+Y35WHS5W8KNrFy9F5Q==
```

The archive contains **485 unique regular files**, totaling **37,869,713 unpacked bytes**. Its 197 upstream assets and their notices are preserved. The legacy declaration alias `legacy/build/pdf.d.mts` is included; its SHA-256 is `dc11ac5030092409dd3183dbb24174beaf35739b9b5c90f268b3cf82b9453708`.

## Source and normal build

The accompanying unified patch changes eleven maintained upstream files. It includes the derivative identity and modification notice, optional catalog-metadata implementation and regressions, strict-image implementation and regressions, and the derivative's npm input pin. Apply it to a clean checkout of the exact upstream commit with the ordinary `git apply --check` and `git apply` commands. The accepted patch check succeeded against that source. Retain all upstream distribution inputs, including `external/dist/legacy/build/pdf.d.mts`; do not omit nested `build` directories when preparing source.

The accepted normal build used **Node 24.22.0**, **npm 11.13.0**, the patched upstream package inputs, and 2,353 source inputs. Relevant installed tools were gulp 5.0.1, gulp-cli 3.1.0, webpack 5.104.1, TypeScript 5.9.3, tsc-alias 1.8.16, Jasmine 5.13.0 and @napi-rs/canvas 0.1.88. Emission used the existing upstream task:

```sh
node node_modules/gulp/bin/gulp.js dist
```

The resulting `build/dist` was packed by the ordinary npm 11.13.0 `pack` command with `--offline --ignore-scripts`. No alternate packaging pipeline is required. A future rebuild must be independently reviewed and qualified; these commands alone do not establish identical archive bytes.

## Qualification and limits

Bounded private native qualification completed on 2026-10-18 using actual Node PDF.js bundles, matching workers, LoopbackPort and Canvas: seven metadata fixtures opened in both modes through both modern and legacy pairs (**28 openings**); **53 image cases per pair, 106 total**; and four stock/previous-derivative worker mismatch controls, all rejected. The strict declaration consumer passed; 93 declaration files matched the preceding metadata.1 derivative. The source-level 53-case image check, all archive paths and hashes, retained assets/licenses and exact package identity were also checked.

This is bounded native evidence. It does not establish browser-worker qualification, complete PDF inspection, OCR correctness, upload approval, hard process isolation or production deployment. Catalog evidence remains `documentComplete: false`. Known unchanged upstream full-source TypeScript findings remain: **20 TS1111 diagnostics across five files**. The **10 existing lint findings** remain baseline limitations. A successful normal distribution build must not be described as a clean full-source TypeScript or lint run.

## License, review and replacement

PDF.js retains its upstream **Apache-2.0** license. [LICENSE](LICENSE) and [MODIFICATIONS.md](MODIFICATIONS.md) are byte-identical to their files inside the archive. Preserve the archive's upstream copyright headers, asset licenses and third-party notices; this dependency is not relicensed under the application's license. No upstream endorsement is asserted.

Keep this archive and version immutable. Any source, generated API/worker, declaration, asset or notice change requires a distinct derivative version/build identity, updated hashes and review of the affected behavior. Replace the derivative only after an upstream release or another qualified package preserves the required strict metadata/image contracts, matching API/worker identity, declaration nullability and existing consumer rejection/cleanup behavior. Use the existing dependency and publication owners; verify the exact published archive bytes before an application dependency pin is adopted. Preserve previous custody versions for audit and rollback.
