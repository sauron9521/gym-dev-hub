'use client';

import { useState } from 'react';
import type { WorktreePatchRecovery } from '@gym-dev-hub/contracts';
import { CodexPatchChecksPanel } from './codex-patch-checks-panel';

type Props = {
  sessionId: string;
  planId: string;
  fingerprint: string;
  sourceCommit: string;
};

/** Read-only recovery; no secrets or one-time grants persisted in browser storage. */
export function WorktreePatchRecoveryPanel({
  sessionId,
  planId,
  fingerprint,
  sourceCommit,
}: Props) {
  const [operatorSecret, setOperatorSecret] = useState('');
  const [recovered, setRecovered] = useState<WorktreePatchRecovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recover() {
    if (busy || operatorSecret.length < 32) return;
    const secret = operatorSecret;
    setOperatorSecret('');
    setRecovered(null);
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        '/api/workspace/sessions/' + sessionId + '/worktree-plans/' + planId + '/patch-recover',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ operatorSecret: secret }),
        },
      );
      if (!response.ok) {
        throw new Error(
          'Немає однозначного застосованого патча. Перевір приватний audit і Git; не застосовуй патч повторно.',
        );
      }
      const value = (await response.json()) as WorktreePatchRecovery;
      if (
        value.readOnly !== true ||
        value.grantIssued !== false ||
        value.writesPerformed !== false ||
        value.applied.status !== 'applied' ||
        value.applied.sessionId !== sessionId ||
        value.applied.planId !== planId ||
        value.applied.sourceCommit !== sourceCommit ||
        value.applied.mergeEnabled !== false ||
        value.applied.githubPushEnabled !== false ||
        value.verified.status !== 'verified' ||
        value.verified.sessionId !== sessionId ||
        value.verified.planId !== planId ||
        value.verified.grantId !== value.applied.grantId ||
        value.verified.filePath !== value.applied.filePath ||
        value.verified.sourceCommit !== sourceCommit ||
        value.verified.sourceSha256 !== value.applied.sourceSha256 ||
        value.verified.proposedSha256 !== value.applied.proposedSha256 ||
        value.verified.changedFiles !== 1 ||
        value.verified.readOnly !== true ||
        value.verified.testsExecuted !== false ||
        value.verified.commitCreated !== false ||
        value.verified.pushEnabled !== false ||
        value.verified.mergeEnabled !== false
      ) {
        throw new Error('Сервер повернув некоректне відновлення. Жодна дія не дозволена.');
      }
      setRecovered(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не вдалося відновити аудит патча.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-worktree-authorization" aria-label="Відновлення застосованого патча">
      <div className="overline">POST-APPLY RECOVERY · READ-ONLY</div>
      <h4>Продовжити після застосованого патча</h4>
      <p>
        Після перезавантаження сторінки повернися до вже перевіреної зміни: звіримо приватний audit
        і фактичний Git diff без нового patch або write-grant. Docker-перевірки потребують окремих
        одноразових дозволів.
      </p>
      <label htmlFor="ws-patch-recovery-secret">Секрет post-apply Git review</label>
      <input
        id="ws-patch-recovery-secret"
        type="password"
        autoComplete="off"
        value={operatorSecret}
        disabled={busy}
        onChange={(event) => setOperatorSecret(event.target.value)}
        placeholder="DEV_HUB_PATCH_APPLY_OPERATOR_SECRET"
      />
      <button
        type="button"
        className="refresh"
        disabled={busy || operatorSecret.length < 32}
        onClick={() => void recover()}
      >
        {busy ? 'Перевіряємо audit і Git…' : 'Read-only відновлення патча'}
      </button>
      {error && (
        <p className="ws-chat-error" role="alert">
          {error}
        </p>
      )}
      {recovered && (
        <div role="status">
          <strong>Патч відновлено: один перевірений файл, без повторного запису.</strong>
          <p>
            <code>{recovered.verified.filePath}</code> · commit{' '}
            <code>{recovered.verified.sourceCommit.slice(0, 12)}</code>
          </p>
          <pre className="ws-code-read-result">
            <code>{recovered.verified.diff}</code>
          </pre>
          <CodexPatchChecksPanel
            sessionId={sessionId}
            planId={planId}
            fingerprint={fingerprint}
            applied={recovered.applied}
            verified={recovered.verified}
          />
        </div>
      )}
    </section>
  );
}
