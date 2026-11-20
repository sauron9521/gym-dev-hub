# Dedicated diagnostic image for the FUTURE task runner.
# No repository source, credentials, Docker socket, or arbitrary task execution.
# Same reviewed Alpine 3.23 digest as the existing fixed-protocol worker.
FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2

LABEL org.gym-dev-hub.runner.protocol="1" \
      org.gym-dev-hub.runner.execution="disabled" \
      org.gym-dev-hub.runner.toolchain="node24-pnpm12.18.0"

# Build-time network only: install a trusted runtime, NEVER project packages.
# --ignore-scripts disables package lifecycle scripts while provisioning pnpm.
RUN apk add --no-cache nodejs npm \
    && test "$(node -p 'process.versions.node.split(".")[0]')" = "24" \
    && npm install --global --ignore-scripts --no-audit --no-fund pnpm@12.18.0 \
    && test "$(pnpm --version)" = "12.18.0" \
    && ln -s "$(command -v pnpm)" /usr/bin/devhub-pnpm \
    && test "$(/usr/bin/devhub-pnpm --version)" = "12.18.0" \
    && npm cache clean --force

COPY --chown=65534:65534 runner.mjs /opt/gym-dev-hub/runner.mjs
# CI-only offline fixture demonstrator: not reachable through the fixed runtime protocol.
COPY --chown=65534:65534 offline-provision.mjs /opt/gym-dev-hub/offline-provision.mjs
# Separate CI-only trust-pin verification. Not exposed via runner.mjs.
COPY --chown=65534:65534 cache-verify.mjs /opt/gym-dev-hub/cache-verify.mjs
# CI-only actual registry tarball SRI verifier. Not exposed by runner protocol.
COPY --chown=65534:65534 real-artifact-verify.mjs /opt/gym-dev-hub/real-artifact-verify.mjs
# CI-only fixed real two-package offline install (not available through runner protocol).
COPY --chown=65534:65534 offline-real-pair.mjs /opt/gym-dev-hub/offline-real-pair.mjs
# CI-only TypeScript 6 smoke: fixture-only compiled code, no API/runner access.
COPY --chown=65534:65534 offline-typescript-smoke.mjs /opt/gym-dev-hub/offline-typescript-smoke.mjs
# CI-only first real SHA-pinned Gym Platform source typecheck, not an API tool.
COPY --chown=65534:65534 pinned-source-typecheck.mjs /opt/gym-dev-hub/pinned-source-typecheck.mjs
# CI-only full immutable Git source snapshot auditor; no project scripts or API surface.
COPY --chown=65534:65534 full-source-audit.mjs /opt/gym-dev-hub/full-source-audit.mjs
# CI-only ephemeral scratch-volume proof; not available via runner protocol.
COPY --chown=65534:65534 overlay-preflight.mjs /opt/gym-dev-hub/overlay-preflight.mjs
# CI-only real API offline cache rehydration; not exposed by runner protocol.
COPY --chown=65534:65534 offline-api-cache.mjs /opt/gym-dev-hub/offline-api-cache.mjs
# CI-only approved Prisma 7 generator proof, no API/task runner entrypoint.
COPY --chown=65534:65534 prisma-native-preflight.mjs /opt/gym-dev-hub/prisma-native-preflight.mjs
# CI-only metadata inventory for Alpine/musl native binaries; no dlopen or API execution.
COPY --chown=65534:65534 native-binary-inspect.mjs /opt/gym-dev-hub/native-binary-inspect.mjs
COPY --chown=65534:65534 native-compatibility-preflight.mjs /opt/gym-dev-hub/native-compatibility-preflight.mjs
# CI-only fixed native runtime experiment; unreachable via the diagnostic runner protocol.
COPY --chown=65534:65534 native-runtime-smoke.mjs /opt/gym-dev-hub/native-runtime-smoke.mjs
COPY --chown=65534:65534 native-runtime-fixture.mjs /opt/gym-dev-hub/native-runtime-fixture.mjs
USER 65534:65534
ENTRYPOINT ["/usr/bin/node", "/opt/gym-dev-hub/runner.mjs"]
