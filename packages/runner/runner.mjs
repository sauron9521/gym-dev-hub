// Strictly diagnostic, bounded, fixed protocol.
 // DO NOT add child_process, eval, project dependency execution, or dynamic imports.
import { Buffer } from 'node:buffer';

const MAX_BUFFER_BYTES = 4096;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
let pending = Buffer.alloc(0);
let shuttingDown = false;

function respond(event, extra = {}) {
  process.stdout.write(JSON.stringify({ protocol: 1, event, executionEnabled: false, ...extra }) + '\n');
}
function reject() {
  respond('rejected', { code: 'UNSUPPORTED_REQUEST' });
}
function handle(message) {
  if (shuttingDown) return;
  switch (message) {
    case 'HELLO/1':
      respond('ready');
      break;
    case 'PING/1':
      respond('pong');
      break;
    case 'TOOLCHAIN/1':
      respond('toolchain', {
        nodeMajor: NODE_MAJOR,
        pnpmVersion: '12.18.0',
        repositoryMounted: false,
        scriptsEnabled: false,
      });
      break;
    case 'SHUTDOWN/1':
      shuttingDown = true;
      process.stdin.pause();
      process.stdout.write(
        JSON.stringify({ protocol: 1, event: 'stopped', executionEnabled: false }) + '\n',
        () => process.exit(0),
      );
      break;
    default:
      reject();
  }
}

process.stdin.on('data', (chunk) => {
  if (shuttingDown) return;
  if (!Buffer.isBuffer(chunk) || pending.length + chunk.length > MAX_BUFFER_BYTES) {
    reject();
    process.exitCode = 1;
    process.stdin.pause();
    return;
  }
  pending = Buffer.concat([pending, chunk]);
  let end = pending.indexOf(10); // LF
  while (end !== -1 && !shuttingDown) {
    const line = pending.subarray(0, end).toString('utf8');
    pending = pending.subarray(end + 1);
    handle(line);
    end = pending.indexOf(10);
  }
});
process.stdin.on('end', () => {
  if (!shuttingDown) process.exitCode = 1;
});
