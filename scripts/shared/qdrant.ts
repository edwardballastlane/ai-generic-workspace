/**
 * Shared Qdrant connection config.
 *
 * Centralizes the Qdrant base URL and authentication so every client (embedder,
 * dashboard generator, backup, search) talks to the same instance with the same
 * credentials. Set these env vars to point at a shared/hosted Qdrant (e.g.
 * Qdrant Cloud) instead of the local Docker default:
 *
 *   - QDRANT_URL: the cluster REST endpoint, e.g. https://<cluster>.cloud.qdrant.io:6333
 *   - QDRANT_API_KEY: the cluster API key (required by Qdrant Cloud; leave unset for local Docker)
 *
 * Qdrant Cloud authenticates via the `api-key` request header. When
 * QDRANT_API_KEY is unset (local Docker) no auth header is sent and behavior is
 * unchanged.
 */

export const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
export const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

/**
 * Build request headers for a Qdrant REST call, merging in the `api-key` header
 * when QDRANT_API_KEY is configured. Pass any extra headers (e.g.
 * `{ 'Content-Type': 'application/json' }` for write calls).
 */
export function qdrantHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;
  return headers;
}
