/**
 * CI-only fixed native load fixture, never exposed via Hub's runner protocol.
 * Requires the reviewed copy of packages under a private /native exec tmpfs.
 * No application source, untrusted input, or externally supplied arguments.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

async function main() {
  if (process.argv.length !== 2) throw new Error('No native fixture arguments permitted');
  const require = createRequire('/native/fixed-native-runtime-probe.cjs');
  const bcrypt = require('bcrypt');
  const password = 'gym-dev-hub-fixed-native-smoke';
  const hashed = bcrypt.hashSync(password, 4);
  assert.ok(hashed.startsWith('$2b$04$'));
  assert.equal(bcrypt.compareSync(password, hashed), true);
  assert.equal(bcrypt.compareSync('not-matching', hashed), false);

  const sharp = require('sharp');
  const input = {
    create: {
      width: 2,
      height: 3,
      channels: 4,
      background: { r: 41, g: 93, b: 151, alpha: 1 },
    },
  };
  const buffer = await sharp(input).png().toBuffer();
  assert.ok(buffer.length > 40 && buffer.length < 4096);
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 3);

  process.stdout.write(
    JSON.stringify({
      event: 'pinned-alpine-native-runtime-probe',
      bcryptVerified: true,
      sharpPngRoundTrip: true,
      nativePackagesLoaded: true,
    }) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write('Fixed native fixture failed: ' + String(error).slice(0, 800) + '\n');
  process.exitCode = 1;
});
