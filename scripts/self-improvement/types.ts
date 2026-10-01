/**
 * Shared types for the self-improvement system.
 */

export interface RuleActor {
  name: string;
  email: string;
}

export interface RuleHistoryEvent {
  at: string;
  event: 'created' | 'staged' | 'activated' | 'rejected' | 'reinforced' | 'retired' | 'restored' | 'promoted-to-team' | 'consolidated' | 'demoted';
  actor: RuleActor;
  detail?: string;
}

export interface Rule {
  id: string;
  text: string;
  source: 'insight-extraction' | 'reflection' | 'manual' | string;
  status: 'active' | 'proposed' | 'stale' | 'retired';
  reinforcementCount: number;
  createdAt: string;
  lastReinforced: string;
  sourceSessionIds: string[];
  categories?: string[];
  projects?: string[];
  // Original creator captured at addRule() time. Set lazily — older rules
  // pre-dating this field stay undefined; their first audit event still
  // names whoever next mutated them.
  author?: RuleActor;
  // Promotion metadata stamped by `npm run rules:promote-apply` when a
  // personal rule graduates into rules-shared.json.
  promotedBy?: RuleActor;
  promotedAt?: string;
  // Append-only audit log. Every status mutation is recorded with who/when/why.
  history?: RuleHistoryEvent[];
  // Consolidation metadata (set by the consolidation engine). A retired rule
  // absorbed into a survivor records `consolidatedInto`; the survivor records
  // the ids it absorbed in `consolidatedFrom`.
  consolidatedInto?: string;
  consolidatedFrom?: string[];
}

export interface Reflection {
  session_id: string;
  date: string;
  failure_type: string;
  failure_description: string;
  root_cause: string;
  reflection: string;
  prevention_rule: string;
  quality_score: number;
}

export interface SkillCandidate {
  name: string;
  description: string;
  status: 'proposed' | 'approved' | 'rejected';
  skillMd: string;
  autoActivation: string[];
  createdAt: string;
  sourceSessionId: string;
  noveltyScore: number;
  qualityScore: number;
}

export interface StagedChange {
  id: string;
  type: 'rule' | 'skill';
  description: string;
  content: string;
  status: 'proposed' | 'applied' | 'rejected';
  createdAt: string;
  appliedAt?: string;
}

export interface Config {
  approvalMode: 'autonomous' | 'propose-and-confirm' | 'review-only';
  maxActiveRules: number;
  stalenessThresholdDays: number;
  minReinforcementsToKeep: number;
  noveltyThreshold: number;
  qualityThresholdSuccess: number;
  qualityThresholdFailure: number;
  deduplicationSimilarity: number;
  reinforcementWindowDays?: number;
  reinforcementScoreThreshold?: number;
  reinforcementQualityMin?: number;
  reinforcementSearchLimit?: number;
  // Consolidation: cosine similarity above which two active rules are merged
  // (deliberately stricter than deduplicationSimilarity — we touch active rules).
  consolidationSimilarity?: number;
  // Contradiction detection runs on pairs whose similarity falls in
  // [contradictionSimilarityFloor, consolidationSimilarity) — related but not duplicate.
  contradictionSimilarityFloor?: number;
  // Cap on the number of Claude contradiction checks per run (bounds LLM cost).
  maxContradictionChecks?: number;
}
