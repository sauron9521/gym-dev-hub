#!/bin/sh
# Worker protocol v1. No eval, shell expansion of input, external commands,
# repository mounts, tooling, or arbitrary user/agent command execution.
set -eu
while IFS= read -r request; do
  case "$request" in
    'HELLO/1')
      printf '%s\n' '{"protocol":1,"event":"ready","executionEnabled":false}'
      ;;
    'PING/1')
      printf '%s\n' '{"protocol":1,"event":"pong","executionEnabled":false}'
      ;;
    'SHUTDOWN/1')
      printf '%s\n' '{"protocol":1,"event":"stopped","executionEnabled":false}'
      exit 0
      ;;
    *)
      printf '%s\n' '{"protocol":1,"event":"rejected","executionEnabled":false,"code":"UNSUPPORTED_REQUEST"}'
      ;;
  esac
done
