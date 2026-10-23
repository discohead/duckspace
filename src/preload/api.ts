/**
 * Re-exports for the Duckspace preload bridge API types.
 *
 * Canonical definitions live in `@shared/types`. Re-exported here so
 * preload-internal code (`preload/index.ts`) can import from a local path.
 */

export type { DuckspaceAPI } from '@shared/types';
