import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreePatchRecoveryPanel } from './worktree-patch-recovery-panel';

const sessionId = '00000000-0000-4000-8000-000000000456';
const planId = '00000000-0000-4000-8000-000000000123';

describe('read-only recovery of an applied one-file patch', () => {
  it('requires an explicit review secret and reveals no previous patch or write controls', () => {
    const html = renderToStaticMarkup(
      <WorktreePatchRecoveryPanel
        sessionId={sessionId}
        planId={planId}
        fingerprint={'sha256:' + 'b'.repeat(64)}
        sourceCommit={'d'.repeat(40)}
      />,
    );
    expect(html).toContain('Read-only відновлення патча');
    expect(html).toContain('DEV_HUB_PATCH_APPLY_OPERATOR_SECRET');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Створити commit');
    expect(html).not.toContain('Застосувати патч');
    expect(html).not.toContain('Злити');
    expect(html).not.toContain(sessionId);
    expect(html).not.toContain(planId);
  });
});
