#!/bin/sh
# Fixed protocol: no eval, user-defined commands or shell interpretation of
# repository content. Explicit scoped reads are bounded and always read-only.
set -efu
reject() {
  printf '%s\n' '{"protocol":1,"event":"rejected","executionEnabled":false,"code":"UNSUPPORTED_REQUEST"}'
}
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
    'CHECK/1 SHA256 '*)
      # Fixed built-in capability: calculate one digest, never execute repo code.
      rel=${request#CHECK/1 SHA256 }
      case "$rel" in
        ''|/*|*'..'*|*'//'*|*[!a-zA-Z0-9._/-]*)
          reject
          continue
          ;;
      esac
      if [ "${#rel}" -gt 160 ]; then reject; continue; fi
      case "$rel" in
        *.ts|*.tsx|*.js|*.jsx|*.json|*.md|*.css|*.html|*.yml|*.yaml)
          ;;
        *) reject; continue ;;
      esac
      current=/workspace
      previous_ifs=$IFS
      IFS=/
      invalid=0
      for part in $rel; do
        case "$part" in ''|.*) invalid=1; break ;; esac
        current="$current/$part"
        if [ -L "$current" ]; then invalid=1; break; fi
      done
      IFS=$previous_ifs
      if [ "$invalid" -ne 0 ] || [ ! -f "$current" ] || [ ! -r "$current" ]; then
        reject
        continue
      fi
      length=$(wc -c < "$current") || { reject; continue; }
      if [ "$length" -gt 8192 ]; then reject; continue; fi
      digest=$(sha256sum < "$current") || { reject; continue; }
      digest=${digest%% *}
      case "$digest" in
        *[!0-9a-f]*) reject; continue ;;
      esac
      if [ "${#digest}" -ne 64 ]; then reject; continue; fi
      printf '{"protocol":1,"event":"digest","executionEnabled":false,"sha256":"%s"}\n' "$digest"
      ;;
    'READ/1 '*)
      rel=${request#READ/1 }
      case "$rel" in
        ''|/*|*'..'*|*'//'*|*[!a-zA-Z0-9._/-]*)
          reject
          continue
          ;;
      esac
      if [ "${#rel}" -gt 160 ]; then reject; continue; fi
      case "$rel" in
        *.ts|*.tsx|*.js|*.jsx|*.json|*.md|*.css|*.html|*.yml|*.yaml)
          ;;
        *) reject; continue ;;
      esac
      current=/workspace
      previous_ifs=$IFS
      IFS=/
      invalid=0
      for part in $rel; do
        case "$part" in ''|.*) invalid=1; break ;; esac
        current="$current/$part"
        if [ -L "$current" ]; then invalid=1; break; fi
      done
      IFS=$previous_ifs
      if [ "$invalid" -ne 0 ] || [ ! -f "$current" ] || [ ! -r "$current" ]; then
        reject
        continue
      fi
      length=$(wc -c < "$current") || { reject; continue; }
      if [ "$length" -gt 8192 ]; then reject; continue; fi
      content=$(base64 "$current" | tr -d '\r\n') || { reject; continue; }
      printf '{"protocol":1,"event":"file","executionEnabled":false,"contentBase64":"%s"}\n' "$content"
      ;;
    *)
      reject
      ;;
  esac
done
