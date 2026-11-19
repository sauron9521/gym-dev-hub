import { describe, expect, it } from 'vitest';
import { evaluateReadiness, type EvaluationInput } from '../src/github/readiness-evaluator.js';

const base: EvaluationInput = {
  repository: 'sauron9521/gym-dev-hub',
  number: 3,
  title: 'PR Checks',
  url: 'https://github.com/sauron9521/gym-dev-hub/pull/3',
  headSha: 'a1b2c3',
  baseBranch: 'main',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  policy: 'classic-required',
  requiredRules: [{ name: 'Verify (Node 24)', appId: 42 }],
  unavailable: [],
  checks: [
    {
      name: 'Verify (Node 24)',
      provider: 'github-actions',
      appId: 42,
      source: 'check-run',
      state: 'success',
      detail: 'success',
      url: 'https://github.com/check',
    },
  ],
};

describe('evaluateReadiness', () => {
  it('is ready for manual review only when known check and required contexts pass', () => {
    const result = evaluateReadiness(base);
    expect(result.verdict).toBe('ready-for-review');
    expect(result.requiredState).toBe('success');
    expect(result.headSha).toBe('a1b2c3');
  });

  it('blocks failure even if other evidence is unavailable', () => {
    const result = evaluateReadiness({
      ...base,
      checks: [{ ...base.checks[0], state: 'failure' }],
      unavailable: ['commit-statuses'],
    });
    expect(result.verdict).toBe('blocked');
    expect(result.checksState).toBe('unknown');
    expect(result.requiredState).toBe('failure');
  });

  it('blocks draft and merge conflicts despite green checks', () => {
    expect(evaluateReadiness({ ...base, draft: true }).verdict).toBe('blocked');
    expect(evaluateReadiness({ ...base, mergeable: false }).verdict).toBe('blocked');
  });

  it('never reports a behind or blocked branch as review-ready', () => {
    expect(evaluateReadiness({ ...base, mergeableState: 'behind' }).verdict).toBe('pending');
    expect(evaluateReadiness({ ...base, mergeableState: 'blocked' }).verdict).toBe('blocked');
    expect(evaluateReadiness({ ...base, mergeableState: 'unstable' }).verdict).toBe('unknown');
  });

  it('never declares ready when a required check has not appeared', () => {
    const result = evaluateReadiness({
      ...base,
      requiredRules: [{ name: 'Required missing', appId: 42 }],
    });
    expect(result.verdict).toBe('pending');
    expect(result.requiredChecks[0].state).toBe('pending');
  });

  it('does not accept a same-name check from the wrong app', () => {
    const result = evaluateReadiness({
      ...base,
      checks: [{ ...base.checks[0], appId: 77 }],
    });
    expect(result.requiredState).toBe('pending');
    expect(result.verdict).toBe('pending');
  });

  it('does not mark missing data or zero checks as successful', () => {
    expect(evaluateReadiness({ ...base, checks: [], policy: 'unavailable' }).verdict).toBe(
      'unknown',
    );
    expect(evaluateReadiness({ ...base, unavailable: ['branch-protection'] }).verdict).toBe(
      'unknown',
    );
    expect(evaluateReadiness({ ...base, mergeable: null }).verdict).toBe('pending');
  });

  it('accepts classic unprotected branches only for manual review (not merge)', () => {
    const result = evaluateReadiness({
      ...base,
      policy: 'none-detected',
      requiredRules: [],
    });
    expect(result.verdict).toBe('ready-for-review');
    expect(result.reasons.join(' ')).toContain('Rulesets');
  });
});
