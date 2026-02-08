/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "main-cannot-import-renderer",
      severity: "error",
      comment: "Main process must not import renderer code",
      from: { path: "^src/main" },
      to: { path: "^src/renderer" },
    },
    {
      name: "renderer-cannot-import-main",
      severity: "error",
      comment: "Renderer must not import main process code",
      from: { path: "^src/renderer" },
      to: { path: "^src/main" },
    },
    {
      name: "workers-cannot-import-main",
      severity: "error",
      comment: "Workers must not import main process code",
      from: { path: "^src/workers" },
      to: { path: "^src/main" },
    },
    {
      name: "workers-cannot-import-renderer",
      severity: "error",
      comment: "Workers must not import renderer code",
      from: { path: "^src/workers" },
      to: { path: "^src/renderer" },
    },
    {
      name: "shared-must-be-leaf",
      severity: "error",
      comment: "Shared code must not import from process-specific directories",
      from: { path: "^src/shared" },
      to: { path: "^src/(main|renderer|workers|preload)" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "No circular dependencies allowed",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
  },
};
