import type pg from 'pg';
import { MemoryReadContextSchema } from '@gym-dev-hub/contracts';
import type { MemoryPrincipal } from './memory-authorization.service.js';
import { MemorySecurityError } from './memory-security-policy.js';

/**
 * Verify bearer-derived principal membership in the dedicated Hub memory DB.
 * A valid bearer only establishes a claimed scope: it must never alone authorize
 * access to a repository, task, session or agent-private record.
 *
 * The HTTP gateway calls this on EVERY read, not just at credential issuance.
 * Agent credentials must be bound to an exact, existing task/session pair.
 */
export async function verifyMemoryPrincipalBinding(
  principal: MemoryPrincipal,
  db: Pick<pg.Pool, 'query'>,
): Promise<MemoryPrincipal> {
  const parsed = MemoryReadContextSchema.safeParse(principal.readContext);
  if (
    !parsed.success ||
    !(
      principal.permission === 'READ_VERIFIED' ||
      (principal.permission === 'PROPOSE_MEMORY' && principal.type === 'agent')
    ) ||
    principal.repository !== parsed.data.repository ||
    !['agent', 'external'].includes(principal.type) ||
    (principal.type === 'agent' &&
      (!parsed.data.agentId || !parsed.data.taskId || !parsed.data.sessionId)) ||
    (principal.type === 'external' && (parsed.data.agentId || parsed.data.sessionId)) ||
    (parsed.data.sessionId && !parsed.data.taskId)
  ) {
    throw new MemorySecurityError('forbidden');
  }

  const { repository, taskId, sessionId, agentId } = parsed.data;
  try {
    // Bind every identifier to the SAME repository. For task-bound agents,
    // require a real agent/task session association, not unrelated IDs.
    // An explicit session must match the complete bearer scope exactly.
    const result = await db.query<{
      repository_exists: boolean;
      task_exists: boolean;
      agent_exists: boolean;
      session_exists: boolean;
      membership_exists: boolean;
    }>(
      `SELECT
        EXISTS(SELECT 1 FROM memory_repositories r WHERE r.name=$1) AS repository_exists,
        ($2::uuid IS NULL OR EXISTS(
          SELECT 1 FROM memory_tasks t WHERE t.repository=$1 AND t.id=$2::uuid
        )) AS task_exists,
        ($3::uuid IS NULL OR EXISTS(
          SELECT 1 FROM memory_agent_identities a WHERE a.repository=$1 AND a.id=$3::uuid
        )) AS agent_exists,
        ($4::uuid IS NULL OR EXISTS(
          SELECT 1 FROM memory_sessions s WHERE s.repository=$1 AND s.id=$4::uuid
            AND s.task_id IS NOT DISTINCT FROM $2::uuid
            AND s.agent_id IS NOT DISTINCT FROM $3::uuid
        )) AS session_exists,
        ($2::uuid IS NULL OR $3::uuid IS NULL OR EXISTS(
          SELECT 1 FROM memory_sessions s WHERE s.repository=$1
            AND s.task_id=$2::uuid AND s.agent_id=$3::uuid
        )) AS membership_exists`,
      [repository, taskId ?? null, agentId ?? null, sessionId ?? null],
    );
    const row = result.rows[0];
    if (
      !row ||
      !row.repository_exists ||
      !row.task_exists ||
      !row.agent_exists ||
      !row.session_exists ||
      !row.membership_exists
    ) {
      throw new MemorySecurityError('forbidden');
    }
  } catch (error) {
    if (error instanceof MemorySecurityError) throw error;
    // Database outage/missing migrations must NEVER become an empty or permitted scope.
    throw new MemorySecurityError('disabled');
  }

  return principal;
}
