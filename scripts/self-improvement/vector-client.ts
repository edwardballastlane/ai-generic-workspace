/**
 * Vector-client factory for the self-improvement pipeline.
 *
 * Routes reflections / rules / session-embedding access to either the Qdrant
 * client (default) or the local file-backed client, selected by VECTOR_BACKEND:
 *
 *   VECTOR_BACKEND=qdrant (default) → ./qdrant-client  (server at QDRANT_URL)
 *   VECTOR_BACKEND=local            → ./local-vector-client  (no server)
 *
 * Consumers import this module (`import * as qdrant from './vector-client'`) so
 * the backend is chosen in one place.
 */

import * as qdrantClient from './qdrant-client';
import * as localClient from './local-vector-client';

const backend = (process.env.VECTOR_BACKEND || 'qdrant').toLowerCase() === 'local'
  ? localClient
  : qdrantClient;

export const isQdrantAvailable = backend.isQdrantAvailable;
export const storeReflection = backend.storeReflection;
export const searchReflections = backend.searchReflections;
export const getReflectionStats = backend.getReflectionStats;
export const searchSessions = backend.searchSessions;
export const scrollSessions = backend.scrollSessions;
export const storeRule = backend.storeRule;
export const searchRules = backend.searchRules;
export const deleteRule = backend.deleteRule;
export const deleteRulesBatch = backend.deleteRulesBatch;
export const syncAllRules = backend.syncAllRules;
export const getRuleStats = backend.getRuleStats;
