# Offline build using the exact base digest already reviewed in PR #7.
FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2

LABEL org.gym-dev-hub.worker.protocol="1" \
      org.gym-dev-hub.worker.execution="disabled"

COPY worker.sh /opt/gym-dev-hub/worker.sh
USER 65534:65534
ENTRYPOINT ["/bin/sh", "/opt/gym-dev-hub/worker.sh"]
