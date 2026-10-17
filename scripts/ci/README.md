# Reusing qualified build output

`Fork Employee Image` compiles the application in its existing Lighthouse job. After all tests,
rendered-browser checks and the Lighthouse audit pass, that job uploads `frontend-build-<commit>`
for one day. The image job downloads the exact named artifact from the same workflow run.

`frontend-build.mjs` owns the artifact format and its validation. The manifest binds the source
revision, `package-lock.json` and every file's size and SHA256. It carries the five nonempty compiled
output directories: `client/dist` and `packages/{data-provider,data-schemas,api,client}/dist`.
Installation rejects mismatched, missing, unlisted or symlinked files before replacing those outputs.
Only pure JavaScript and static output is transferred; image dependencies are installed normally.

From the component root, after a successful `npm run e2e:prepare` and the required CI gates:

```bash
node scripts/ci/frontend-build.mjs pack --revision "$(git rev-parse HEAD)" --directory ci-build
node --test scripts/ci/frontend-build.test.mjs
```

The pack directory must be absent or empty. Docker builds require BuildKit with Dockerfile frontend
1.19. Setting `PREBUILT_FRONTEND_COMMIT` to the exact checkout commit installs the verified artifact
from `ci-build`; leaving it empty retains the normal source build. The artifact is mounted read-only
and excluded from image layers. Other image workflows retain the default source build.

Hashes verify integrity, while provenance depends on the successful same-run producer. Reuse is
intended for the fork workflow's default frontend configuration; a custom build-time frontend setting
requires its corresponding qualified build or the default source-build path. Artifact expiration
requires rerunning the producer; there is no silent rebuild fallback. A filesystem error during
replacement aborts the image build, so an incomplete image cannot be published.
