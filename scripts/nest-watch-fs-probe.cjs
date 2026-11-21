/*
 * Diagnostic-only Node preload: trace ONLY file-change notifications seen by
 * Node's TypeScript/Nest watchers, never contents, tokens or arbitrary paths.
 * Activated only by the explicit `diagnose:nest-watch` launcher.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');

const LOG_MAX_BYTES = 256 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
function hashShort(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function describePath(projectRoot, raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return 'unavailable';
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(String(raw));
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative === '' || relative === '.') return 'repo-root';
  if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    return 'external/' + hashShort(absolute);
  }
  if (relative.startsWith('apps/api/.local/')) return 'apps/api/.local/<redacted>';
  const safePaths = [
    'apps/api/src/',
    'apps/api/dist/',
    'packages/contracts/src/',
    'packages/contracts/dist/',
  ];
  if (
    safePaths.some((prefix) => relative.startsWith(prefix)) &&
    /\.(?:ts|tsx|js|json|mjs|cjs)$/.test(relative)
  ) {
    // Do not include names suggesting hidden credentials, even if nested in src.
    if (!/(?:^|\/)(?:\.|[^/]*(?:secret|token|credential|key)[^/]*)/i.test(relative))
      return relative;
  }
  if (
    /^(?:apps\/api\/(?:nest-cli|tsconfig(?:\.build)?)\.json|packages\/contracts\/tsconfig\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(
      relative,
    )
  ) {
    return relative;
  }
  return 'repo-other/' + hashShort(relative);
}

function boundedRecord(destination, record) {
  const line = JSON.stringify(record) + '\n';
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_APPEND | O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && (stat.mode & 0o077) !== 0) ||
      stat.size + Buffer.byteLength(line) > LOG_MAX_BYTES
    )
      return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    fs.writeSync(fd, line);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function installProbe(projectRoot, output) {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(output))
    throw Error('Absolute diagnostic paths required');
  if (!fs.statSync(output).isFile()) throw Error('Pre-created diagnostic file required');
  const watchedPath = path.resolve(projectRoot);
  const label = (source, filename) => {
    const directory = path.resolve(String(source));
    // A watch can refer to a file, not a directory. Avoid treating a file as
    // a directory when an event also includes a filename.
    const target =
      filename && fs.existsSync(directory) && fs.statSync(directory).isDirectory()
        ? path.join(directory, String(filename))
        : directory;
    return describePath(watchedPath, target);
  };
  const started = Date.now();
  let genericEvents = 0;
  let lastGenericEvent = 0;
  const emit = (kind, source, filename, event) => {
    try {
      const location = label(source, filename);
      // Compiler startup can notify hundreds of dependency/cache paths that
      // cannot safely be named. Sample these, but keep *all* owned source and
      // config notifications so the 256 KiB budget lasts until a real trigger.
      if (location.startsWith('repo-other/') || location.startsWith('external/')) {
        genericEvents++;
        const now = Date.now();
        if (now - started < 7_000 && genericEvents > 30) return;
        if (now - lastGenericEvent < 100) return;
        lastGenericEvent = now;
      }
      boundedRecord(output, {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        event: kind,
        change: typeof event === 'string' ? event.slice(0, 24) : undefined,
        path: location,
      });
    } catch {
      // Observation may never alter Nest watch semantics or block a restart.
    }
  };
  emit('process-start', watchedPath, undefined, undefined);
  const originalWatch = fs.watch;
  fs.watch = function diagnosticWatch(...args) {
    const watcher = originalWatch.apply(this, args);
    const originalEmit = watcher.emit;
    watcher.emit = function diagnosticEmit(eventName, ...eventArgs) {
      if (eventName === 'change') emit('fs.watch', args[0], eventArgs[1], eventArgs[0]);
      return originalEmit.call(this, eventName, ...eventArgs);
    };
    return watcher;
  };
  const originalWatchFile = fs.watchFile;
  const originalUnwatchFile = fs.unwatchFile;
  const listeners = new Map();
  fs.watchFile = function diagnosticWatchFile(...args) {
    const listener = args[args.length - 1];
    if (typeof listener !== 'function') return originalWatchFile.apply(this, args);
    const wrapped = (...values) => {
      emit('fs.watchFile', args[0], undefined, 'change');
      return listener(...values);
    };
    let key = listeners.get(String(args[0]));
    if (!key) {
      key = new Map();
      listeners.set(String(args[0]), key);
    }
    key.set(listener, wrapped);
    return originalWatchFile.apply(this, [...args.slice(0, -1), wrapped]);
  };
  fs.unwatchFile = function diagnosticUnwatchFile(filename, listener) {
    const key = listeners.get(String(filename));
    if (listener) {
      const wrapped = key?.get(listener) ?? listener;
      key?.delete(listener);
      return originalUnwatchFile.call(this, filename, wrapped);
    }
    listeners.delete(String(filename));
    return originalUnwatchFile.call(this, filename);
  };
  syncBuiltinESMExports();
}

if (process.env.DEV_HUB_WATCH_DIAGNOSTIC_LOG && process.env.DEV_HUB_WATCH_DIAGNOSTIC_ROOT) {
  installProbe(process.env.DEV_HUB_WATCH_DIAGNOSTIC_ROOT, process.env.DEV_HUB_WATCH_DIAGNOSTIC_LOG);
}

module.exports = { describePath, boundedRecord, installProbe, LOG_MAX_BYTES };
