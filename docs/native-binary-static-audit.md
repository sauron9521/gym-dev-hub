# PR #34 — Static native binary inventory (CI-only)

This is a **read-only metadata check**, not a native runtime test and not authorization to execute API_TYPECHECK.

The pinned Gym Platform source is still commit 7104f723c4ee7b81e7b9b64e9c9483aea344ef7a. The workflow reuses the same trusted CI stage from PR #33: a Git-pinned 1,258-file source archive, separately verified pnpm store, privately mounted engine SHA-256, read-only binds and a non-root, networkless disposable Alpine 3.23 container. There are **no user-supplied commands or package lifecycle scripts**.

The CI-only native-compatibility-preflight.mjs first runs the independently checked script-free offline-api-cache.mjs for the exact API dependency graph, then uses native-binary-inspect.mjs to read bounded ELF headers from these candidate paths under the disposable project:

- bcrypt/prebuilds/linux-x64/bcrypt.musl.node
- @img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64.node
- @img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so*
- The independent, fixed SHA-256 Prisma 7 linux-musl-openssl-3.0.x schema-engine under the read-only /engine mount.

For each package candidate it reports either **missing** or **ELF64 / little-endian / x86_64 header**. Unexpected/symlinked/out-of-root files, malformed headers and wrong architectures fail closed. It does not import native bindings, invoke the engine, inspect all dynamic dependencies, or guarantee musl ABI / OpenSSL / libvips runtime compatibility. A correct ELF header is **necessary, not sufficient**.

If a musl optional package is absent (for example because dependencies were originally cached by the trusted Ubuntu host), CI **reports missing instead of faking readiness**. Static-only inspection may succeed while some packages are missing: allExpectedHeadersPresent explicitly records the result, and runtimeCompatibilityCertified is always false. There is **no execution eligibility upgrade** from a green workflow.

## Checks and future gate

- Node fixture tests accept a known ELF64/x86_64 header and reject incorrect ELF class, endianness, machine, type, symlink input and missing file.
- The existing Docker CI step asserts the immutable source/engine identity, network-disabled and script-free conditions, and a fixed JSON event with explicit **execution-disabled** fields.
- Future separately reviewed work must provide/verify platform-correct prebuilt packages, inspect dynamic linker dependencies, and demonstrate bounded native runtime loading **inside an isolated sandbox** before approving the actual API typecheck.
- The normal Hub HTTP API, runner.mjs fixed-protocol entrypoint, agent permissions and operator grants remain unchanged; GitHub merge is still manual.

## PR #35 — Pinned musl dependency cache

The previous CI proof correctly reported missing sharp and libvips musl binaries. The pinned Gym Platform lockfile already includes these **exact** optional packages and their SHA-512 records:

- @img/sharp-linuxmusl-x64@0.35.5
- @img/sharp-libvips-linuxmusl-x64@1.3.4

In the trusted, network-enabled CI staging step, pnpm 12.18.0 temporarily receives supportedArchitectures for linux-x64 and linux-x64-musl, without touching the immutable source archive or the original lockfile. Git-pinned lock SRI is checked before fetching, scripts remain disabled, and the modified staging config is restored before checking git cleanliness. The resulting read-only pnpm store becomes available to the unchanged offline Docker install.

The offline, non-root, networkless Docker **static inspector now requires all four native ELF64/x86_64 headers**, including bcrypt and the separately SHA-256-pinned Prisma schema-engine. If the musl optional packages are missing, this workflow must fail (rather than reporting an incomplete set as success).

This is still **not** a certification of dynamic linking, exported symbols, runtime image processing or the actual API typecheck. No native module is loaded in this slice, no task execution or agent permission is activated. Actual runtime loading should be proved in a subsequent separately approved CI-only isolation design.
