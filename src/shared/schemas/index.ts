/**
 * Barrel file for shared Zod schemas.
 *
 * Explicit named exports only — no wildcard re-exports.
 */

export type { DatspaceConfig } from './config-schema';
export { DatspaceConfigSchema } from './config-schema';

export {
  CatalogDescribeRequestSchema,
  CatalogPreviewRequestSchema,
  ConfigGetRequestSchema,
  ConfigSetRequestSchema,
  QueryCancelRequestSchema,
  QueryExecuteRequestSchema,
} from './ipc-schemas';
