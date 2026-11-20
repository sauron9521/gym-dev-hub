#!/bin/sh
# Trusted-network, fixed-source stage. No caller argv or input binds. Writes
# only to the fresh /bundle directory; no host home, credentials or Docker socket.
set -eu
set -o pipefail
test "$#" -eq 0
test "$(id -u)" = 65534
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
test "$(pnpm --version)" = '12.18.0'
test -d /bundle
test -w /bundle
test -z "$(find /bundle -mindepth 1 -maxdepth 1 -print -quit)"
test -z "$(env | grep -E '^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|DATABASE_URL)=.' || true)"
export HOME=/tmp
export XDG_CONFIG_HOME=/tmp
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0
export GIT_NO_LAZY_FETCH=1
export GIT_NO_REPLACE_OBJECTS=1
export GIT_OPTIONAL_LOCKS=0
export npm_config_userconfig=/tmp/nonexistent-user-npmrc
export npm_config_globalconfig=/tmp/nonexistent-global-npmrc
export npm_config_update_notifier=false
export CI=true

commit='7104f723c4ee7b81e7b9b64e9c9483aea344ef7a'
tree='2c140e1e740b3dd8cc7582db726f46b54b73b334'
manifest_sha='dd06a6e61c08886f8c783ffe51152854ed6aeca44115659fabc884d5b180bb0b'
git init -q /tmp/pinned-git
git -C /tmp/pinned-git -c credential.helper= fetch --quiet --depth=1 --no-tags \
  https://github.com/sauron9521/gym-platform.git "$commit"
test "$(git -C /tmp/pinned-git rev-parse FETCH_HEAD)" = "$commit"
test "$(git -C /tmp/pinned-git rev-parse "$commit^{tree}")" = "$tree"

mkdir -p /bundle/source /bundle/manifest /bundle/store /bundle/engine /tmp/project
git -C /tmp/pinned-git ls-tree -r --long -z "$commit" > /bundle/manifest/tracked-files.bin
test "$(sha256sum /bundle/manifest/tracked-files.bin | cut -d' ' -f1)" = "$manifest_sha"
git -C /tmp/pinned-git archive --format=tar "$commit" -o /tmp/tracked-source.tar
tar -xf /tmp/tracked-source.tar -C /bundle/source
test "$(find /bundle/source -type f | wc -l)" -eq 1258
test -z "$(find /bundle/source -type l -print -quit)"
test ! -e /bundle/source/.git

# Independently guard both Alpine-musl optional artifacts against lock drift.
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
const lock = readFileSync('/bundle/source/pnpm-lock.yaml', 'utf8');
const pins = [
  ['@img/sharp-linuxmusl-x64@0.35.5',
   'sha512-4KOphqB035HrVdqLZfCgMzzERrQkkzOwRhl4OAkRO1YCldbaFjySXMaK534Mo0V+LndnlJk+sbUyLeU0ULyD1A=='],
  ['@img/sharp-libvips-linuxmusl-x64@1.3.4',
   'sha512-6zXKeE/p39I1AmA3cJG35eyBGNqNddLnUXjhwBnsGjFPWqf5VKkDBEqaEkPDoTEtkxwi2vv8Tcr2mDyP4So7Fg=='],
];
for (const [name,sri] of pins) {
  if (!lock.includes("  '" + name + "':\n    resolution: {integrity: " + sri + "}")) {
    throw new Error('Unreviewed musl package integrity: ' + name);
  }
}
NODE

# pnpm never touches the exact /bundle/source Git archive. Only this private
# /tmp/project copy has temporary architecture overrides and node_modules.
cp -R /bundle/source/. /tmp/project/
cat >> /tmp/project/pnpm-workspace.yaml <<'YAML'

supportedArchitectures:
  - linux-x64
  - linux-x64-musl
YAML
(
  cd /tmp/project
  pnpm --filter @gym/api install --frozen-lockfile --ignore-scripts \
    --trust-lockfile --store-dir /bundle/store
)
for file in \
 '@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.5.node' \
 '@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7'; do
  test -f "/tmp/project/node_modules/$file" || \
    test -f "/tmp/project/apps/api/node_modules/$file"
done

# pnpm 12 may link store/v11/projects back to its temporary checkout.
# Delete only known 32-digit index symlinks with exact pinned destinations.
projects=/bundle/store/v11/projects
if [ -d "$projects" ]; then
  for entry in "$projects"/*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    test -L "$entry"
    basename "$entry" | grep -Eq '^[a-f0-9]{32}$'
    destination="$(readlink "$entry")"
    case "$destination" in
      /tmp/project|/tmp/project/apps/api) rm -- "$entry" ;;
      *) echo 'Unexpected package index backlink' >&2; exit 1 ;;
    esac
  done
fi
test -z "$(find /bundle/store -type l -print -quit)"
files="$(find /bundle/store -type f | wc -l)"
bytes="$(du -sb /bundle/store | cut -f1)"
test "$files" -ge 50
test "$files" -lt 90000
test "$bytes" -lt 1992294400

# Prisma engine URL/commit and both compressed and uncompressed hashes fixed.
version='d1b3f377ca835d73fd50954a5e22128b9ebdd6b8'
platform='linux-musl-openssl-3.0.x'
url="https://binaries.prisma.sh/all_commits/$version/$platform/schema-engine.gz"
curl --proto '=https' --proto-redir '=https' --fail --location --silent \
  --show-error --retry 3 --max-time 120 \
  "$url" --output /tmp/schema-engine.gz
curl --proto '=https' --proto-redir '=https' --fail --location --silent \
  --show-error --retry 3 --max-time 120 \
  "$url.sha256" --output /tmp/schema-engine.gz.sha256
raw="$(head -c 180 /tmp/schema-engine.gz.sha256)"
upstream="$(printf '%s' "$raw" | grep -oE '[a-f0-9]{64}' | head -n 1)"
compressed="$(sha256sum /tmp/schema-engine.gz | cut -d' ' -f1)"
test "$compressed" = "$upstream"
test "$compressed" = '9a3a5a44f16f1c78403ac4067f3b83c10a03af5e8d417d87e3ab89907eae9ace'
gzip -t /tmp/schema-engine.gz
gzip -dc /tmp/schema-engine.gz > /bundle/engine/schema-engine
test "$(stat -c%s /bundle/engine/schema-engine)" -ge 1000000
test "$(stat -c%s /bundle/engine/schema-engine)" -le 180000000
test "$(head -c4 /bundle/engine/schema-engine | od -An -tx1 | tr -d ' \n')" = '7f454c46'
test "$(sha256sum /bundle/engine/schema-engine | cut -d' ' -f1)" = \
 'c583d08ce5150fe39ff1d4a981c790e3eee8e1fbb432b80dba7606d74c1e56cf'

# World-readable only for nonroot RO mounts. No live source is changed.
chmod -R a+rX /bundle/source /bundle/manifest /bundle/store /bundle/engine
chmod 555 /bundle/engine/schema-engine
printf '%s\n' 'PINNED_LOCAL_API_BUNDLE_STAGED_V1'
