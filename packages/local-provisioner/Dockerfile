# Networked provisioning image: invoked manually; never reachable from the Hub HTTP API.
# The sole writable bind is a fresh empty artifact staging directory.
FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
LABEL org.gym-dev-hub.provisioner.protocol="1" \
      org.gym-dev-hub.provisioner.mode="fixed-pinned-source-only"
RUN apk add --no-cache ca-certificates git curl tar gzip coreutils nodejs npm \
    && test "$(node -p 'process.versions.node.split(".")[0]')" = "24" \
    && npm install --global --ignore-scripts --no-audit --no-fund pnpm@12.18.0 \
    && test "$(pnpm --version)" = "12.18.0" \
    && npm cache clean --force
COPY --chown=65534:65534 stage-pinned-api.sh /opt/gym-dev-hub/stage-pinned-api.sh
USER 65534:65534
ENTRYPOINT ["/bin/sh", "/opt/gym-dev-hub/stage-pinned-api.sh"]
