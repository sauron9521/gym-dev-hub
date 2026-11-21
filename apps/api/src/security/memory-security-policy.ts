import { MemoryRepositorySchema } from '@gym-dev-hub/contracts';

export type MemorySecurityConfiguration = {
  operatorSecret: string;
  repositories: readonly string[];
  trustedOrigin: string;
  externalReadEnabled: boolean;
  proposalWriteEnabled: boolean;
  approvalWriteEnabled: boolean;
};

/** Independent, opt-in memory identity namespace, never existing worktree grants. */
export class MemorySecurityError extends Error {
  constructor(readonly code: 'disabled' | 'unauthorized' | 'forbidden' | 'rate-limited') {
    super(`Memory security ${code}`); // no secret or remote details in errors
    this.name = 'MemorySecurityError';
  }
}

export function memorySecurityConfig(env: NodeJS.ProcessEnv): MemorySecurityConfiguration {
  if (env.DEV_HUB_MEMORY_SECURITY_ENABLE !== 'true') throw new MemorySecurityError('disabled');
  // Auth never activates without explicitly enabled dedicated Hub memory DB.
  if (env.DEV_HUB_MEMORY_ENABLE !== 'true') throw new MemorySecurityError('disabled');
  const operatorSecret = env.DEV_HUB_MEMORY_OPERATOR_SECRET;
  if (
    !operatorSecret ||
    Buffer.byteLength(operatorSecret, 'utf8') < 32 ||
    Buffer.byteLength(operatorSecret, 'utf8') > 256
  ) {
    throw new MemorySecurityError('disabled');
  }
  // Memory approval secrets must not reuse any existing Git, Docker or worktree authorizer.
  if (
    [
      env.DEV_HUB_WORKTREE_OPERATOR_SECRET,
      env.DEV_HUB_TASK_GRANT_OPERATOR_SECRET,
      env.DEV_HUB_WORKER_TOOL_SECRET,
    ].some((value) => Boolean(value) && value === operatorSecret)
  )
    throw new MemorySecurityError('disabled');
  const rawRepos = env.DEV_HUB_MEMORY_ALLOWED_REPOSITORIES;
  if (!rawRepos) throw new MemorySecurityError('disabled');
  const repositories = rawRepos.split(',').map((x) => x.trim());
  if (
    repositories.length === 0 ||
    repositories.length > 16 ||
    new Set(repositories).size !== repositories.length ||
    repositories.some((x) => !MemoryRepositorySchema.safeParse(x).success)
  )
    throw new MemorySecurityError('disabled');
  const trustedOrigin = env.DEV_HUB_MEMORY_TRUSTED_ORIGIN;
  if (!trustedOrigin) throw new MemorySecurityError('disabled');
  let origin: URL;
  try {
    origin = new URL(trustedOrigin);
  } catch {
    throw new MemorySecurityError('disabled');
  }
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    !origin.port ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    trustedOrigin !== origin.origin
  )
    throw new MemorySecurityError('disabled');
  const externalFlag = env.DEV_HUB_MEMORY_EXTERNAL_READ_ENABLE;
  if (externalFlag !== undefined && externalFlag !== 'true' && externalFlag !== 'false')
    throw new MemorySecurityError('disabled');
  const proposalFlag = env.DEV_HUB_MEMORY_PROPOSALS_HTTP_ENABLE;
  if (proposalFlag !== undefined && proposalFlag !== 'true' && proposalFlag !== 'false')
    throw new MemorySecurityError('disabled');
  const approvalFlag = env.DEV_HUB_MEMORY_APPROVAL_HTTP_ENABLE;
  if (approvalFlag !== undefined && approvalFlag !== 'true' && approvalFlag !== 'false')
    throw new MemorySecurityError('disabled');
  return {
    operatorSecret,
    repositories,
    trustedOrigin: origin.origin,
    externalReadEnabled: externalFlag === 'true',
    proposalWriteEnabled: proposalFlag === 'true',
    approvalWriteEnabled: approvalFlag === 'true',
  };
}

export type LocalMemoryHttpRequest = {
  method: string;
  host: string | undefined;
  remoteAddress: string | undefined;
  origin: string | undefined;
  fetchSite: string | undefined;
  path: string;
};

/** Boundary checks for future HTTP wiring. A local network address is NOT authentication. */
export function assertMemoryLocalBoundary(
  request: LocalMemoryHttpRequest,
  trustedOrigin: string,
): void {
  const allowedIp = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (!request.remoteAddress || !allowedIp.has(request.remoteAddress))
    throw new MemorySecurityError('forbidden');
  const host = request.host;
  if (!host || host.includes('@') || host.includes(',') || /[\r\n]/.test(host))
    throw new MemorySecurityError('forbidden');
  let parsed: URL;
  try {
    parsed = new URL('http://' + host);
  } catch {
    throw new MemorySecurityError('forbidden');
  }
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.host !== host ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new MemorySecurityError('forbidden');
  }
  if (request.fetchSite && !['same-origin', 'none'].includes(request.fetchSite))
    throw new MemorySecurityError('forbidden');
  const isSafeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
  // State-changing web actions always require the exact, explicit local UI origin.
  if ((!isSafeMethod && !request.origin) || (request.origin && request.origin !== trustedOrigin)) {
    throw new MemorySecurityError('forbidden');
  }
  // Reject bearer/token values in URL, including the untrusted query string.
  if (/[?&](?:token|access_token|secret|api_key|authorization)=/i.test(request.path)) {
    throw new MemorySecurityError('forbidden');
  }
}
