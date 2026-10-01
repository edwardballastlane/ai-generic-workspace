/**
 * Result Enhancer: Staleness warnings and session deduplication for search results.
 *
 * Based on findings from:
 * - arXiv 2601.22984 (PIES taxonomy): Agents over-rely on early/redundant info (anchor + homogeneity bias)
 * - arXiv 2601.23228 (MAPPA): Per-action quality signals improve downstream decisions
 */

export enum StalenessLevel {
  FRESH = 'Fresh',
  RECENT = 'Recent',
  AGING = 'Aging',
  STALE = 'Stale',
  VERY_STALE = 'Very Stale',
}

export interface StalenessInfo {
  level: StalenessLevel;
  ageDays: number;
  warning: string | null;
  icon: string;
}

export function getStaleness(dateStr: string): StalenessInfo {
  const ageDays = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);

  if (ageDays < 7) {
    return { level: StalenessLevel.FRESH, ageDays, warning: null, icon: '' };
  }
  if (ageDays < 30) {
    return { level: StalenessLevel.RECENT, ageDays, warning: null, icon: '' };
  }
  if (ageDays < 90) {
    return {
      level: StalenessLevel.AGING,
      ageDays,
      warning: 'Result is 30+ days old - verify referenced files/code still exist',
      icon: '[!]',
    };
  }
  if (ageDays < 365) {
    return {
      level: StalenessLevel.STALE,
      ageDays,
      warning: 'Result is 90+ days old - codebase may have changed significantly',
      icon: '[!!]',
    };
  }
  return {
    level: StalenessLevel.VERY_STALE,
    ageDays,
    warning: 'Result is over 1 year old - treat as historical reference only',
    icon: '[!!!]',
  };
}

export function formatStaleness(dateStr: string): string {
  const info = getStaleness(dateStr);
  if (info.warning) {
    return `${info.icon} ${info.level} (${Math.round(info.ageDays)}d) - ${info.warning}`;
  }
  return `${info.level} (${Math.round(info.ageDays)}d)`;
}

/**
 * Deduplicate results by session ID, keeping only the highest-scoring chunk per session.
 * This counteracts the homogeneity bias identified in the PIES research - agents
 * over-weight redundant information from the same source.
 */
export interface DeduplicableResult {
  session_id?: string;
  sessionId?: string;
  id?: string;
  score?: number;
  combined_score?: number;
  hybridScore?: number;
  metadata?: { date?: string };
}

export function deduplicateBySession<T extends DeduplicableResult>(
  results: T[],
  targetCount: number,
): T[] {
  const sessionMap = new Map<string, T[]>();

  for (const r of results) {
    const sessionId = r.session_id || r.sessionId || r.id?.split('-chunk-')[0] || 'unknown';
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, []);
    }
    sessionMap.get(sessionId)!.push(r);
  }

  // If every result is from a unique session, no dedup needed
  if (sessionMap.size === results.length) {
    return results.slice(0, targetCount);
  }

  // Take the best chunk from each session first (ensures diversity)
  const diverse: T[] = [];
  Array.from(sessionMap.values()).forEach(chunks => {
    diverse.push(chunks[0]); // Already sorted by score from upstream
  });

  // Sort diverse results by their score
  diverse.sort((a, b) => {
    const scoreA = a.combined_score ?? a.hybridScore ?? a.score ?? 0;
    const scoreB = b.combined_score ?? b.hybridScore ?? b.score ?? 0;
    return scoreB - scoreA;
  });

  // If we have enough diverse results, return them
  if (diverse.length >= targetCount) {
    return diverse.slice(0, targetCount);
  }

  // Otherwise, fill remaining slots with second-best chunks from sessions
  const remaining = targetCount - diverse.length;
  const extras: T[] = [];
  Array.from(sessionMap.values()).forEach(chunks => {
    if (chunks.length > 1) {
      extras.push(...chunks.slice(1));
    }
  });
  extras.sort((a, b) => {
    const scoreA = a.combined_score ?? a.hybridScore ?? a.score ?? 0;
    const scoreB = b.combined_score ?? b.hybridScore ?? b.score ?? 0;
    return scoreB - scoreA;
  });

  return [...diverse, ...extras.slice(0, remaining)];
}

/**
 * Count how many unique sessions appear in results (diversity metric).
 */
export function sessionDiversityCount<T extends DeduplicableResult>(results: T[]): number {
  const sessions = new Set<string>();
  for (const r of results) {
    const sessionId = r.session_id || r.sessionId || r.id?.split('-chunk-')[0] || 'unknown';
    sessions.add(sessionId);
  }
  return sessions.size;
}
