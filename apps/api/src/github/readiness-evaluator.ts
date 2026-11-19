import type {
  GitHubCIState,
  PullCheck,
  PullReadiness,
  ReadinessVerdict,
  RequiredCheck,
  RequiredPolicy,
} from '@gym-dev-hub/contracts';

interface RequiredRule {
  name: string;
  appId: number | null;
}

export interface EvaluationInput {
  repository: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  baseBranch: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  checks: PullCheck[];
  policy: RequiredPolicy;
  requiredRules: RequiredRule[];
  unavailable: PullReadiness['unavailable'];
}

function aggregate(states: GitHubCIState[]): GitHubCIState {
  if (!states.length) return 'unknown';
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.includes('unknown')) return 'unknown';
  return 'success';
}

function requiredState(
  rule: RequiredRule,
  checks: PullCheck[],
  unavailable: PullReadiness['unavailable'],
): GitHubCIState {
  const matches = checks.filter(
    (check) =>
      check.name === rule.name &&
      (rule.appId === null || (check.source === 'check-run' && check.appId === rule.appId)),
  );
  // A missing required check may have been excluded by an unavailable API.
  if (!matches.length) {
    const possibleSources =
      rule.appId !== null ? ['check-runs'] : ['check-runs', 'commit-statuses'];
    return possibleSources.some((source) => unavailable.includes(source as 'check-runs'))
      ? 'unknown'
      : 'pending';
  }
  return aggregate(matches.map((check) => check.state));
}

export function evaluateReadiness(input: EvaluationInput): PullReadiness {
  const checksState = input.unavailable.some(
    (source) => source === 'check-runs' || source === 'commit-statuses',
  )
    ? 'unknown'
    : aggregate(input.checks.map((check) => check.state));

  const requiredChecks: RequiredCheck[] = input.requiredRules.map((rule) => ({
    ...rule,
    state: requiredState(rule, input.checks, input.unavailable),
  }));
  const requiredStateSummary: GitHubCIState =
    input.policy === 'unavailable'
      ? 'unknown'
      : requiredChecks.length
        ? aggregate(requiredChecks.map((check) => check.state))
        : 'success';

  const reasons: string[] = [];
  let verdict: ReadinessVerdict = 'ready-for-review';

  if (input.draft) reasons.push('PR залишається в статусі Draft.');
  if (
    input.mergeable === false ||
    input.mergeableState === 'dirty' ||
    input.mergeableState === 'blocked'
  ) {
    reasons.push('GitHub повідомляє про конфлікти або неможливість злиття.');
  }
  if (checksState === 'failure' || requiredStateSummary === 'failure') {
    reasons.push('Щонайменше одна перевірка завершилася помилкою.');
  }
  if (reasons.length) verdict = 'blocked';
  else if (
    checksState === 'pending' ||
    requiredStateSummary === 'pending' ||
    input.mergeableState === 'behind' ||
    input.mergeable === null
  ) {
    verdict = 'pending';
    reasons.push('Очікуємо завершення GitHub-перевірок або розрахунку mergeability.');
  } else if (
    checksState === 'unknown' ||
    requiredStateSummary === 'unknown' ||
    ['unknown', 'unstable'].includes(input.mergeableState) ||
    input.unavailable.length > 0
  ) {
    verdict = 'unknown';
    reasons.push('Не всі дані GitHub доступні: готовність не підтверджена.');
  } else {
    reasons.push('Відомі перевірки завершилися успішно; PR можна передавати на ручний review.');
  }

  if (input.policy === 'none-detected') {
    reasons.push(
      'Класичних required checks не знайдено; GitHub Rulesets та вимоги review можуть діяти окремо.',
    );
  }

  return {
    repository: input.repository,
    number: input.number,
    title: input.title,
    url: input.url,
    baseBranch: input.baseBranch,
    headSha: input.headSha,
    draft: input.draft,
    mergeable: input.mergeable,
    mergeableState: input.mergeableState,
    fetchedAt: new Date().toISOString(),
    checks: input.checks,
    checksState,
    policy: input.policy,
    requiredChecks,
    requiredState: requiredStateSummary,
    verdict,
    reasons,
    unavailable: input.unavailable,
  };
}
