/**
 * Rule audit trail — captures who/when/what for every state change a rule
 * goes through. Read by `npm run self:stats` and the effectiveness report so
 * you can answer "who originated this team rule and when was it promoted?".
 */

import { execFileSync } from 'child_process';
import type { Rule, RuleActor, RuleHistoryEvent } from './types';

export type { RuleActor, RuleHistoryEvent } from './types';
export type RuleHistoryEventKind = RuleHistoryEvent['event'];

let cachedActor: RuleActor | null = null;

function gitConfig(key: string): string {
  try {
    return execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function getActor(): RuleActor {
  if (cachedActor) return cachedActor;
  const name = gitConfig('user.name') || process.env.USER || process.env.USERNAME || 'unknown';
  const email = gitConfig('user.email') || process.env.EMAIL || '';
  cachedActor = { name, email };
  return cachedActor;
}

export function appendHistory(
  rule: Rule,
  event: RuleHistoryEventKind,
  detail?: string,
  actor?: RuleActor,
  at?: string,
): void {
  if (!Array.isArray(rule.history)) rule.history = [];
  const entry: RuleHistoryEvent = {
    at: at || new Date().toISOString(),
    event,
    actor: actor || getActor(),
  };
  if (detail) entry.detail = detail;
  rule.history.push(entry);
}
