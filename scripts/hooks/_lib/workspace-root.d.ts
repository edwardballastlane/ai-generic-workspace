/**
 * TypeScript declarations for the plain-JS workspace-root helper.
 * Kept as a .d.ts (not rewriting the .js as .ts) so plain-Node hook
 * scripts can continue to `require()` it without a ts-node process.
 */
export function findWorkspaceRoot(startDir?: string): string;
