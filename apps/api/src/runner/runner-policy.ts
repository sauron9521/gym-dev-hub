/**
 * Pure policy for a future Node/pnpm diagnostic runner.
 * There is deliberately no Docker spawn, API route, grant, or mount capability.
 */
export const RUNNER_IMAGE = 'gym-dev-hub-node-runner:v1';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_NAME =
  /^gym-dev-hub-node-runner-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRYPOINT = JSON.stringify(['/usr/bin/node', '/opt/gym-dev-hub/runner.mjs']);

export function validateRunnerImage(raw: string): string {
  const delimiter = raw.indexOf('|');
  if (delimiter < 0) throw new Error('Invalid runner image metadata');
  const imageId = raw.slice(0, delimiter);
  if (!SHA256.test(imageId)) throw new Error('Runner image must have an immutable ID');
  let image: {
    Labels?: Record<string, string>;
    Entrypoint?: string[];
    User?: string;
  };
  try {
    image = JSON.parse(raw.slice(delimiter + 1)) as typeof image;
  } catch {
    throw new Error('Invalid runner image JSON');
  }
  if (
    !image ||
    image.User !== '65534:65534' ||
    JSON.stringify(image.Entrypoint) !== ENTRYPOINT ||
    image.Labels?.['org.gym-dev-hub.runner.protocol'] !== '1' ||
    image.Labels?.['org.gym-dev-hub.runner.execution'] !== 'disabled' ||
    image.Labels?.['org.gym-dev-hub.runner.toolchain'] !== 'node24-pnpm12.18.0'
  ) {
    throw new Error('Untrusted Node runner image configuration');
  }
  return imageId;
}

/** Future launcher must use this closed policy verbatim and re-inspect Docker. */
export function diagnosticRunnerArguments(containerName: string, imageId: string): string[] {
  if (!CONTAINER_NAME.test(containerName)) throw new Error('Invalid runner container name');
  if (!SHA256.test(imageId)) throw new Error('Runner requires pinned image ID');
  return [
    'run',
    '--rm',
    '-i',
    '--pull=never',
    '--name',
    containerName,
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=65534:65534',
    '--pids-limit=128',
    '--memory=2048m',
    '--cpus=2',
    '--ipc=none',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
    '--stop-timeout=3',
    imageId,
  ];
}
