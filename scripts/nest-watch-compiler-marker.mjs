/**
 * A fixed, bounded watch-output classifier: never persist terminal output.
 * Watch may split "File change detected." across stdout chunks.
 */
const CHANGE_MARKER = 'File change detected. Starting incremental compilation...';

export function createNestCompilerMarker(onRebuild) {
  if (typeof onRebuild !== 'function') throw new TypeError('Expected a fixed marker callback');
  let tail = '';
  return function observe(chunk) {
    const text = tail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    let offset = 0;
    while ((offset = text.indexOf(CHANGE_MARKER, offset)) !== -1) {
      // The retained tail is shorter than the complete marker, so matches
      // cannot be emitted twice when stdout arrives in multiple chunks.
      onRebuild();
      offset += CHANGE_MARKER.length;
    }
    tail = text.slice(-(CHANGE_MARKER.length - 1));
  };
}
