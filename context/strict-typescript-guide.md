# Strict TypeScript Project Configuration Guide

## Purpose and Philosophy

This document defines the standards, tooling, and patterns for creating **agent-ready TypeScript codebases**—projects optimized for both human developers and AI coding agents to understand, navigate, and modify with high confidence.

### Core Thesis

AI coding agents and human developers share the same fundamental needs when working with code:

1. **Unambiguous contracts** — Know what a function expects and returns without reading implementation
2. **Predictable structure** — Find things where you expect them to be
3. **Immediate feedback** — Know when you've broken something before runtime
4. **Traceable dependencies** — Understand how components connect
5. **Self-documenting code** — Understand intent without external documentation

The difference is that agents can't ask clarifying questions mid-task, can't intuit unwritten conventions, and work from static context windows. What helps agents helps everyone—but agents expose the gaps that humans paper over with tribal knowledge.

**Strict typing, comprehensive linting, and enforced documentation aren't bureaucratic overhead—they're executable specifications that make code reliably modifiable by any agent, human or AI.**

---

## Design Goals

### 1. Zero Ambiguity at Boundaries

Every function signature should be a complete contract:

```typescript
// ❌ Ambiguous — agent must read implementation to understand
function process(data: any) {
  // ...
}

// ✅ Self-documenting — signature tells the full story
/**
 * Transform a raw user event into an analytics payload.
 *
 * @param event - The incoming user event to process.
 * @returns A validated analytics payload ready for ingestion.
 * @throws {@link ValidationError} If the event contains invalid data.
 */
function process(event: UserEvent): AnalyticsPayload {
  // ...
}
```

### 2. Fail Fast, Fail Loudly

Errors should surface at the earliest possible moment:

| Error Type                  | When Caught | Tool                               |
| --------------------------- | ----------- | ---------------------------------- |
| Type mismatches             | Edit time   | `tsc --strict` + IDE               |
| Import errors               | Edit time   | `tsc` + Biome/ESLint               |
| Style violations            | Pre-commit  | Biome (or ESLint + Prettier)       |
| Missing docs                | Pre-commit  | eslint-plugin-tsdoc / jsdoc        |
| Dead code                   | CI          | Knip                               |
| Architecture violations     | CI          | dependency-cruiser                 |
| Runtime type errors         | Test time   | Zod + Vitest                       |
| Security issues             | CI          | eslint-plugin-security + npm audit |
| Untested code paths         | CI          | v8 coverage                        |
| Tests that don't catch bugs | CI          | Stryker                            |

### 3. Maximum Grep-ability

Code should be searchable and traceable:

```typescript
// ❌ Hard to trace
import * as models from "./models";
const result = (handler as any)[actionName]();

// ✅ Explicit and traceable
import { User, Event } from "./models/user.js";
const result = handler.createUser();
```

### 4. Mechanical Verifiability

Every quality standard must be automatically enforceable—no "best practices" that require human judgment to verify.

---

## Tool Selection Rationale

### Static Type Checking: `tsc --strict` (TypeScript Compiler)

**Why `tsc --strict`:**

TypeScript's compiler is both the type checker and the language server powering every major IDE. Unlike Python where Pyright and mypy compete, TypeScript has a single canonical type checker.

**Why this matters for agents:** All AI coding tools (Cursor, Claude Code, GitHub Copilot) use the TypeScript language server. Your project's strictness settings directly control the agent's type analysis.

**Configuration philosophy:**

We use `strict: true` plus every additional strictness flag. The goal is zero `@ts-ignore` comments—every suppression should use `@ts-expect-error` with a specific explanation:

```typescript
// ❌ Opaque — what are we ignoring?
// @ts-ignore
x = foo();

// ✅ Specific and auditable
// @ts-expect-error Third-party lib has incorrect types for this overload
x = foo();
```

`@ts-expect-error` is strictly preferred over `@ts-ignore` because it errors when the suppression is no longer needed (the underlying issue was fixed), preventing stale suppressions from accumulating.

**What `strict: true` enables:**

| Flag                           | What It Does                                     |
| ------------------------------ | ------------------------------------------------ |
| `noImplicitAny`                | Error on inferred `any` — forces explicit types  |
| `strictNullChecks`             | `null`/`undefined` not assignable to other types |
| `strictFunctionTypes`          | Strict contravariant parameter checking          |
| `strictBindCallApply`          | Strict types for `bind`, `call`, `apply`         |
| `strictPropertyInitialization` | Class properties must be initialized             |
| `noImplicitThis`               | Error on `this` with implicit `any` type         |
| `alwaysStrict`                 | Emit `"use strict"` in every file                |
| `useUnknownInCatchVariables`   | `catch(e)` gives `unknown` not `any`             |

### Linting and Formatting: Biome (primary) or ESLint + Prettier (when needed)

**Why Biome as the default:**

Previously, a TypeScript project needed:

- Prettier (formatting)
- ESLint (linting)
- eslint-plugin-import (import rules)
- eslint-plugin-unused-imports (dead import removal)
- Various ESLint configs and plugins

Biome consolidates formatting and linting into a single tool that's 20–100x faster than the tools it replaces. This means:

1. **Faster feedback** — Sub-second linting on large codebases
2. **Consistent configuration** — One `biome.json` file
3. **No tool conflicts** — Unified rule resolution (no Prettier + ESLint fights)
4. **Simpler CI** — One tool to install and run

**When to use ESLint instead:**

Biome covers the majority of projects, but ESLint remains necessary if you need:

- **Type-aware lint rules** (e.g., `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`)
- **Specialized plugins** not yet in Biome (e.g., `eslint-plugin-tsdoc`, `eslint-plugin-security`)
- **React-specific rules** from `eslint-plugin-react-hooks`

If you need these, use **ESLint v9 flat config** with `typescript-eslint` and Biome (or Prettier) for formatting only. Never use ESLint for formatting.

**Configuration philosophy:**

Whether using Biome or ESLint, we start with the strictest presets and explicitly disable only rules that conflict with our formatter or are inappropriate for our specific use case. This "allowlist by exclusion" approach means new rules are automatically enforced when tools add them.

### Runtime Validation: Zod

**Why Zod (the Pydantic of TypeScript):**

1. **Schema introspection** — Agents can inspect `.shape` to understand data structures
2. **Type inference** — `z.infer<typeof Schema>` generates TypeScript types from schemas
3. **Descriptive fields** — `.describe("...")` adds agent-readable documentation
4. **Discriminated unions** — `z.discriminatedUnion()` for clean pattern matching
5. **JSON schema** — `zod-to-json-schema` for schema export
6. **Ecosystem** — tRPC, React Hook Form, and most TypeScript tools integrate natively

**Configuration philosophy:**

We use maximum strictness with `.strict()` (forbid extra fields) and `z.infer` for type generation:

```typescript
import { z } from "zod";

// Base schema pattern: strict mode, explicit descriptions
const UserEventSchema = z
  .object({
    eventId: z
      .string()
      .uuid()
      .describe("Unique identifier for this event instance"),
    userId: z.string().uuid().describe("The user who triggered this event"),
    eventType: z
      .enum(["click", "view", "purchase"])
      .describe("Category of event"),
    timestamp: z
      .string()
      .datetime()
      .describe("ISO 8601 UTC timestamp when the event occurred"),
    properties: z
      .record(z.unknown())
      .default({})
      .describe("Additional event-specific properties"),
  })
  .strict(); // No undeclared fields (equivalent to Pydantic extra="forbid")

// Derive TypeScript type from schema
type UserEvent = z.infer<typeof UserEventSchema>;

// Readonly variant (equivalent to Pydantic frozen=True)
type ReadonlyUserEvent = Readonly<z.infer<typeof UserEventSchema>>;
```

**Why `.strict()`:** Silently accepting unknown fields hides bugs. If a field isn't in the schema, it should error.

**Why `Readonly<>`:** Immutable types are easier to reason about. An agent modifying code doesn't have to trace mutation paths.

### Testing: Vitest + fast-check + Stryker

**Why this combination:**

| Tool       | Purpose                | What it catches                           |
| ---------- | ---------------------- | ----------------------------------------- |
| Vitest     | Example-based testing  | Known edge cases                          |
| fast-check | Property-based testing | Edge cases you didn't think of            |
| Stryker    | Mutation testing       | Tests that don't actually verify behavior |

**Why Vitest over Jest:**

| Factor     | Vitest          | Jest             |
| ---------- | --------------- | ---------------- |
| Speed      | Faster (Vite)   | Slower           |
| TypeScript | Native support  | Requires ts-jest |
| ESM        | Native          | Awkward          |
| Config     | Vite-compatible | Separate config  |
| Watch mode | Faster HMR      | Full re-run      |
| API        | Jest-compatible | —                |

**Property-based testing example:**

```typescript
import { describe, it, expect } from "vitest";
import fc from "fast-check";

describe("sort", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (xs) => {
        const sorted = [...xs].sort((a, b) => a - b);
        const sortedTwice = [...sorted].sort((a, b) => a - b);
        expect(sortedTwice).toEqual(sorted);
      }),
    );
  });

  it("preserves length", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (xs) => {
        expect([...xs].sort((a, b) => a - b)).toHaveLength(xs.length);
      }),
    );
  });
});
```

fast-check generates thousands of random inputs and finds minimal failing cases (shrinking). This catches edge cases that example-based tests miss.

**Mutation testing:**

Stryker modifies your code (e.g., changes `>` to `>=`, `+` to `-`) and verifies that tests fail. If a mutation survives, your tests don't actually verify that code path.

```bash
# Run mutation testing
npx stryker run

# View the HTML report
open reports/mutation/html/index.html
```

### Documentation: TSDoc + eslint-plugin-tsdoc

**Why enforce documentation:**

Doc comments are the primary way agents understand code intent. A function without a doc comment forces the agent to read the implementation—which may be wrong, outdated, or intentionally obscure.

**TSDoc is the standardized comment format for TypeScript** (analogous to Python's docstring conventions + Google style). `eslint-plugin-tsdoc` validates comment syntax. For coverage enforcement, layer on:

- `@typescript-eslint/explicit-function-return-types` — Forces documented return types
- `@typescript-eslint/explicit-module-boundary-types` — Forces documented exports
- `eslint-plugin-jsdoc` with `require-jsdoc` rule — Enforces doc comments on exports

### Architecture Enforcement: dependency-cruiser

**Why this matters:**

Circular imports and architectural violations create dependency tangles that are hard for agents to navigate. dependency-cruiser is the most mature tool for this in the TypeScript ecosystem—it understands TypeScript imports, re-exports, and dynamic imports natively.

```javascript
// .dependency-cruiser.mjs
export default {
  forbidden: [
    {
      name: "models-cannot-import-services",
      severity: "error",
      from: { path: "^src/models" },
      to: { path: "^src/services" },
    },
    {
      name: "utils-must-be-leaf",
      severity: "error",
      from: { path: "^src/utils" },
      to: { path: "^src/(services|handlers)" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
};
```

### Dead Code Detection: Knip

**Why Knip:**

Knip detects unused exports, imports, dependencies, and files. It understands TypeScript, monorepos, and test file patterns out of the box.

```bash
# Find all unused code
npx knip

# Auto-fix (removes unused exports/imports)
npx knip --fix
```

### Security: npm audit + eslint-plugin-security

**Why both:**

- **npm audit** — Finds known vulnerabilities in your dependencies (equivalent to pip-audit)
- **eslint-plugin-security** — Finds security issues in your code (prototype pollution, regex DoS, unsafe eval—equivalent to Bandit)

These run in CI to catch issues before deployment.

---

## Full Configuration Files

### tsconfig.json — Maximum Strictness

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    // ─── Core strict mode (enables 8 strict flags) ────────
    "strict": true,

    // ─── Additional strictness beyond strict: true ────────
    "exactOptionalPropertyTypes": true, // Optional props !== undefined
    "noUncheckedIndexedAccess": true, // Index access returns T | undefined
    "noImplicitReturns": true, // All code paths must return
    "noFallthroughCasesInSwitch": true, // Switch cases must break/return
    "noUnusedLocals": true, // Error on unused variables
    "noUnusedParameters": true, // Error on unused parameters
    "noPropertyAccessFromIndexSignature": true, // Require bracket access for index sigs
    "noImplicitOverride": true, // Require `override` keyword
    "forceConsistentCasingInFileNames": true,

    // ─── Target & Module ──────────────────────────────────
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler", // Use "Node16" for pure Node.js libraries
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",

    // ─── Output ───────────────────────────────────────────
    "declaration": true, // Generate .d.ts (equivalent to py.typed)
    "declarationMap": true, // Source maps for declarations
    "sourceMap": true,

    // ─── Module & Interop ─────────────────────────────────
    "esModuleInterop": true,
    "isolatedModules": true, // Required for Vitest and bundlers
    "verbatimModuleSyntax": true, // Enforce `import type` for type-only imports
    "resolveJsonModule": true,
    "skipLibCheck": true, // Skip checking node_modules .d.ts files

    // ─── Path Aliases ─────────────────────────────────────
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
    },
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"],
}
```

#### Key Flags Explained

**`noUncheckedIndexedAccess`** — The single most impactful flag beyond `strict`. Without it, `array[0]` has type `T`. With it, `array[0]` has type `T | undefined`, forcing you to handle the out-of-bounds case:

```typescript
const items: string[] = [];

// Without noUncheckedIndexedAccess:
const first: string = items[0]; // No error! But it's undefined at runtime.

// With noUncheckedIndexedAccess:
const first: string | undefined = items[0]; // Correct type
if (first !== undefined) {
  console.log(first.toUpperCase()); // Safe
}
```

**`exactOptionalPropertyTypes`** — Distinguishes between "property is missing" and "property is explicitly undefined":

```typescript
interface Config {
  timeout?: number;
}

// Without exactOptionalPropertyTypes:
const config: Config = { timeout: undefined }; // Allowed

// With exactOptionalPropertyTypes:
const config: Config = { timeout: undefined }; // Error!
const config: Config = {}; // OK — property is absent
```

**`verbatimModuleSyntax`** — Enforces `import type` for type-only imports, making it clear to both agents and bundlers what's a value vs. a type:

```typescript
// ❌ Ambiguous — is User a value or a type?
import { User } from "./models.js";

// ✅ Explicit — agent knows this is type-only
import type { User } from "./models.js";
import { createUser } from "./services.js";
```

**`moduleResolution`** — Use `"bundler"` for application code (Vite, Next.js, etc.) and `"Node16"` for pure Node.js libraries that must resolve imports at runtime without a bundler.

### biome.json — Unified Linting and Formatting

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true,
  },
  "organizeImports": {
    "enabled": true,
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf",
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,

      "correctness": {
        "noUndeclaredVariables": "error",
        "noUnusedImports": "error",
        "noUnusedVariables": "error",
        "useExhaustiveDependencies": "error",
      },

      "suspicious": {
        "noExplicitAny": "error",
        "noConfusingVoidType": "error",
        "noEmptyInterface": "error",
        "noExtraNonNullAssertion": "error",
        "useAwait": "error",
      },

      "style": {
        "noDefaultExport": "error",
        "noNonNullAssertion": "error",
        "useConst": "error",
        "useImportType": "error",
        "useExportType": "error",
        "noParameterAssign": "error",
        "useEnumInitializers": "error",
        "useNamingConvention": {
          "level": "error",
          "options": {
            "strictCase": true,
            "conventions": [
              { "selector": { "kind": "typeLike" }, "formats": ["PascalCase"] },
              {
                "selector": { "kind": "variable" },
                "formats": ["camelCase", "CONSTANT_CASE"],
              },
              { "selector": { "kind": "function" }, "formats": ["camelCase"] },
              {
                "selector": { "kind": "enumMember" },
                "formats": ["PascalCase"],
              },
            ],
          },
        },
      },

      "complexity": {
        "noExcessiveCognitiveComplexity": {
          "level": "error",
          "options": { "maxAllowedComplexity": 15 },
        },
        "noForEach": "warn",
        "useFlatMap": "error",
      },

      "performance": {
        "noAccumulatingSpread": "error",
        "noDelete": "warn",
      },
    },
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "all",
      "semicolons": "always",
      "arrowParentheses": "always",
    },
  },
  "files": {
    "ignore": ["node_modules", "dist", "coverage", "*.generated.ts"],
  },
}
```

#### Key Biome Rules Explained

**`noExplicitAny`** — The `any` type is the escape hatch that destroys type safety. Ban it entirely; use `unknown` when the type is truly unknown.

**`noNonNullAssertion`** — The `!` operator (`value!.property`) tells the compiler "trust me, this isn't null." This hides bugs. Use proper narrowing instead.

**`noDefaultExport`** — Default exports are hard to trace, allow silent renaming at import sites, and break auto-import tooling. Named exports are always preferred.

**`useImportType` / `useExportType`** — Enforces `import type` and `export type` for type-only imports/exports, aligning with `verbatimModuleSyntax` in `tsconfig.json`.

### ESLint Flat Config (when Biome isn't sufficient)

For projects requiring type-aware lint rules or specialized plugins, use ESLint alongside Biome (for formatting) or Prettier:

```javascript
// eslint.config.mjs
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  { ignores: ["node_modules", "dist", ".vite", "*.config.*"] },

  // Base JS rules
  js.configs.recommended,

  // Strict type-checked TypeScript rules (strictest preset)
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // TypeScript file configuration
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ─── Strict type safety ─────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/restrict-template-expressions": "error",

      // ─── Enforce documented boundaries ──────────────────
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",

      // ─── Import hygiene ─────────────────────────────────
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",

      // ─── Exhaustiveness and safety ──────────────────────
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chaining": "error",
    },
  },

  // Disable type-checked rules for JS config files
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Relaxed rules for test files
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
```

### vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false, // Explicit imports — no magic globals
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts", "src/**/internal/**"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
    typecheck: {
      enabled: true, // Type-check test files too
    },
  },
});
```

### stryker.config.json

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker/master/packages/core/schema/stryker-core.schema.json",
  "packageManager": "npm",
  "reporters": ["html", "clear-text", "progress"],
  "testRunner": "vitest",
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "mutate": ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/index.ts"],
  "thresholds": {
    "high": 80,
    "low": 60,
    "break": 50,
  },
}
```

---

## Project Structure

```
your-project/
├── package.json                # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration (strict mode)
├── biome.json                  # Linting and formatting (primary)
├── eslint.config.mjs           # ESLint flat config (if type-aware rules needed)
├── vitest.config.ts            # Test configuration
├── stryker.config.json         # Mutation testing configuration
├── .dependency-cruiser.mjs     # Architecture rules
├── .husky/
│   └── pre-commit              # Git hook: lint-staged
├── README.md                   # Project overview and quickstart
├── AGENTS.md                   # Agent-specific context (this document, condensed)
│
├── src/
│   ├── index.ts                # Package entry point (explicit named re-exports only)
│   │
│   ├── models/                 # Data structures (Zod schemas + inferred types)
│   │   ├── index.ts            # Re-exports public models
│   │   ├── user.ts             # One primary schema per file
│   │   └── event.ts
│   │
│   ├── services/               # Business logic
│   │   ├── index.ts
│   │   └── user-service.ts
│   │
│   ├── internal/               # Private implementation details
│   │   └── ...                 # Not part of public API
│   │
│   └── utils/                  # Shared utilities
│       ├── index.ts
│       └── validation.ts
│
├── tests/
│   ├── setup.ts                # Global test setup (equivalent to conftest.py)
│   ├── helpers/                # Shared test utilities and factories
│   │   └── factories.ts
│   ├── unit/                   # Fast, isolated tests
│   │   └── user.test.ts
│   └── integration/            # Tests with external dependencies
│       └── api.test.ts
│
└── scripts/                    # Development and deployment scripts
    └── ...
```

### Structure Principles

1. **`src/` directory** — All source code under `src/` with path aliases for clean imports
2. **One schema per file** — Easy to find, grep, and navigate
3. **Explicit named re-exports** — `index.ts` barrel files with named exports, no `export *`
4. **Internal convention** — `internal/` directories and `_`-prefixed functions signal "don't touch"
5. **Matching names** — `user.ts` schema → `user-service.ts` service → `user.test.ts` test
6. **Kebab-case filenames** — Consistent, avoids case-sensitivity issues across OS

---

## Patterns for Agent-Friendly Code

### 1. Discriminated Unions over Class Hierarchies

```typescript
// ❌ Hard for agents to enumerate possibilities
abstract class Message {
  abstract process(): void;
}
class TextMessage extends Message {
  /* ... */
}
class ImageMessage extends Message {
  /* ... */
}
// Agent must search codebase for all subclasses

// ✅ All variants visible at definition site
type TextMessage = {
  readonly type: "text";
  readonly content: string;
};

type ImageMessage = {
  readonly type: "image";
  readonly url: string;
  readonly altText: string;
};

type Message = TextMessage | ImageMessage; // Complete union visible here
```

### 2. Exhaustiveness Checking with `assertNever`

```typescript
/** Compile-time exhaustiveness check. Fails if cases are missing. */
function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled value: ${JSON.stringify(value)}`);
}

function handleMessage(msg: Message): string {
  switch (msg.type) {
    case "text":
      return msg.content;
    case "image":
      return `[Image: ${msg.altText}]`;
    default:
      return assertNever(msg); // Type error if cases are missing
  }
}
```

If you add a new message type to the union, TypeScript immediately errors on the `assertNever` line until you handle it.

### 3. Branded Types for Semantic Meaning

```typescript
/** Create a branded type for nominal type safety. */
type Brand<T, B extends string> = T & { readonly __brand: B };

type UserId = Brand<string, "UserId">;
type EventId = Brand<string, "EventId">;
type SessionId = Brand<string, "SessionId">;

/** Smart constructor — validates and brands the value. */
function UserId(value: string): UserId {
  if (!value.match(/^usr_/)) throw new Error("UserId must start with usr_");
  return value as UserId;
}

function getUserEvents(userId: UserId): Event[] {
  // ...
}

// Now an agent can grep for "UserId" to find all user ID handling
// And TypeScript prevents mixing up UserId with EventId
const uid = UserId("usr_123");
const eid = "evt_456" as EventId;

getUserEvents(uid); // ✅ OK
// getUserEvents(eid); // ❌ Type error: EventId is not assignable to UserId
```

### 4. Explicit Named Exports (No Default Exports)

```typescript
// ❌ Default export — hard to trace, inconsistent naming
export default function processUser() {
  /* ... */
}
// import handler from './user'; // What is "handler"? Rename at import site.

// ✅ Named export — explicit, greppable, refactorable
export function processUser(): ProcessedUser {
  /* ... */
}
import { processUser } from "./user.js"; // Unambiguous
```

**Why no default exports:**

- Named exports are auto-importable by IDEs and agents
- Renaming at the import site obscures the original name
- Named exports are easier to grep across the codebase
- Tree-shaking works better with named exports

### 5. Explicit Named Re-exports (No Wildcard Barrels)

```typescript
// src/index.ts

// ❌ Wildcard barrel — agent can't determine what's public, bloats bundles
export * from "./models/index.js";
export * from "./services/index.js";

// ✅ Explicit — clear public API surface
export type { User, UserCreateInput } from "./models/user.js";
export type { Event, EventType } from "./models/event.js";
export { createUser, deleteUser } from "./services/user-service.js";
export { UserSchema, EventSchema } from "./models/schemas.js";
```

### 6. Interfaces for Structural Typing

```typescript
/** Any object that can be serialized to JSON. */
interface Serializable {
  toJSON(): Record<string, unknown>;
}

/** Save any serializable object to a JSON file. */
function saveToFile(obj: Serializable, path: string): void {
  writeFileSync(path, JSON.stringify(obj.toJSON()));
}

// Any object with a toJSON method works — no inheritance required
// TypeScript checks structural compatibility automatically
```

### 7. Descriptive Zod Schemas

```typescript
import { z } from "zod";

/** Schema for events triggered by user actions. */
const UserEventSchema = z
  .object({
    eventId: z
      .string()
      .uuid()
      .describe("Unique identifier for this event instance"),
    userId: z.string().uuid().describe("The user who triggered this event"),
    eventType: z
      .enum(["click", "view", "purchase"])
      .describe("Category of event"),
    timestamp: z
      .string()
      .datetime()
      .describe("ISO 8601 UTC timestamp when the event occurred"),
    properties: z
      .record(z.unknown())
      .default({})
      .describe("Additional event-specific properties"),
  })
  .strict();

type UserEvent = z.infer<typeof UserEventSchema>;

// Agents can inspect the schema shape:
// UserEventSchema.shape.eventId.description === 'Unique identifier for this event instance'
```

### 8. Type-Safe Exhaustive Dispatch Maps

```typescript
// ❌ Dynamic dispatch — breaks static analysis
const result = (handler as any)[actionName]();

// ✅ Typed record with compile-time completeness check
const handlers = {
  create: handleCreate,
  update: handleUpdate,
  delete: handleDelete,
} as const satisfies Record<ActionType, ActionHandler>;

// The `satisfies` keyword ensures the record covers all ActionType values
// Adding a new ActionType without a handler is a type error
```

### 9. `satisfies` for Validated Literals

```typescript
// ❌ Type assertion — no validation, widens literal types
const config = {
  retryCount: 3,
  timeout: 5000,
} as Config;

// ✅ satisfies — validated at compile time, preserves literal types
const config = {
  retryCount: 3,
  timeout: 5000,
} satisfies Config;
// TypeScript errors if shape doesn't match Config
// But `config.retryCount` is type `3`, not `number`
```

### 10. `as const` for Immutable Literals

```typescript
// ❌ Mutable, wide types
const ROLES = ["admin", "member", "viewer"]; // type: string[]

// ✅ Immutable, narrow types
const ROLES = ["admin", "member", "viewer"] as const; // type: readonly ["admin", "member", "viewer"]
type Role = (typeof ROLES)[number]; // "admin" | "member" | "viewer"
```

### 11. Consistent Type Imports

```typescript
// ❌ Ambiguous — is User a value or type?
import { User, UserSchema } from "./user.js";

// ✅ Inline type import (enforced by ESLint/Biome + verbatimModuleSyntax)
import { type User, UserSchema } from "./user.js";

// ✅ Or when importing only types:
import type { User, Event } from "./models.js";
```

Type-only imports are erased at compile time and make the dependency graph clearer for agents and bundlers.

---

## Anti-Patterns to Avoid

### The `any` Escape Hatch

```typescript
// ❌ Type information destroyed
function process(data: any): any {
  return data.nested.value;
}

// ✅ Use unknown and narrow
function process(data: unknown): string {
  if (typeof data === "object" && data !== null && "nested" in data) {
    const nested = (data as { nested: { value: string } }).nested;
    return nested.value;
  }
  throw new Error("Invalid data shape");
}

// ✅ Best: Validate at the boundary with Zod
function process(data: unknown): string {
  const parsed = DataSchema.parse(data);
  return parsed.nested.value; // Fully typed
}
```

### Type Assertion Overuse (`as`)

```typescript
// ❌ Unsafe assertion — hides real type errors
const user = response.data as User;

// ✅ Validate at the boundary
const user = UserSchema.parse(response.data);
```

### Non-null Assertions

```typescript
// ❌ "Trust me" — hides null/undefined bugs
const user = users.find((u) => u.id === id)!;
console.log(user.name);

// ✅ Handle the missing case explicitly
const user = users.find((u) => u.id === id);
if (user === undefined) {
  throw new NotFoundError(`User ${id} not found`);
}
console.log(user.name);
```

### Wildcard Re-exports

```typescript
// ❌ Agent can't determine what names are available
export * from "./models";
export * from "./utils";

// ✅ Explicit exports are traceable
export { User, Event } from "./models.js";
export { validate, sanitize } from "./utils.js";
```

### Untyped Object Spread

```typescript
// ❌ Type information lost through spread
function updateUser(user: User, updates: Record<string, unknown>): User {
  return { ...user, ...updates }; // Anything could be in updates
}

// ✅ Explicit update type
function updateUser(
  user: User,
  updates: Partial<Pick<User, "name" | "email">>,
): User {
  return { ...user, ...updates }; // Only known fields
}
```

### Implicit `any` in Callbacks

```typescript
// ❌ If users is untyped, u is `any` and u.name silently passes
const names = users.map((u) => u.name);

// ✅ Explicit parameter types when context is ambiguous
const names = users.map((u: User) => u.name);
```

### Enum Misuse

```typescript
// ❌ TypeScript enums have surprising runtime behavior
enum Status {
  Active = "ACTIVE",
  Inactive = "INACTIVE",
}

// ✅ Union types — no runtime overhead, better inference
type Status = "active" | "inactive";

// ✅ Or const objects when you need runtime values + reverse mapping
const Status = {
  Active: "active",
  Inactive: "inactive",
} as const;
type Status = (typeof Status)[keyof typeof Status];
```

### Bare `@ts-ignore`

```typescript
// ❌ Opaque — suppresses all errors on this line, persists after fix
// @ts-ignore
const x = problematicCall();

// ✅ Specific — documents the issue, errors when suppression is no longer needed
// @ts-expect-error Library @types/foo v2.1 has incorrect overload signature
const x = problematicCall();
```

### Mutable Shared State

```typescript
// ❌ Hidden mutation across modules
export const state = { users: [] as User[] };
// Any module can push to state.users

// ✅ Encapsulated with controlled, immutable access
let _users: readonly User[] = [];

export function addUser(user: User): void {
  _users = [..._users, user];
}

export function getUsers(): readonly User[] {
  return _users;
}
```

---

## Pre-commit Configuration

Install Husky + lint-staged:

```bash
npm install --save-dev husky lint-staged
npx husky init
```

Create `.husky/pre-commit`:

```bash
npx lint-staged
```

Configure `lint-staged` in `package.json`:

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["biome check --write --no-errors-on-unmatched"],
    "*.{json,md,yaml,yml}": ["biome format --write --no-errors-on-unmatched"]
  }
}
```

**Important:** Do not run `tsc --noEmit` in lint-staged—TypeScript's type checker must see the entire project, not just staged files. Run it in CI instead.

### Optional: commitlint for Conventional Commits

```bash
npm install -D @commitlint/cli @commitlint/config-conventional
```

Add `.husky/commit-msg`:

```bash
npx commitlint --edit $1
```

---

## package.json — Scripts and Dependencies

```jsonc
{
  "name": "your-project",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
    },
  },
  "scripts": {
    // ─── Development ─────────────────────────────────────
    "dev": "tsx watch src/index.ts",
    "build": "tsc --build",

    // ─── Quality checks ──────────────────────────────────
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",

    // ─── Testing ─────────────────────────────────────────
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:mutation": "stryker run",

    // ─── Architecture & dead code ────────────────────────
    "arch": "depcruise src --config .dependency-cruiser.mjs",
    "dead-code": "knip",

    // ─── Security ────────────────────────────────────────
    "audit": "npm audit --audit-level=moderate",

    // ─── Composite checks ────────────────────────────────
    "check": "npm run typecheck && npm run lint",
    "check:all": "npm run check && npm run test:coverage && npm run arch && npm run dead-code && npm run audit",

    // ─── Git hooks ───────────────────────────────────────
    "prepare": "husky",
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@biomejs/biome": "^1.9.0",
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0",
    "fast-check": "^3.23.0",
    "@stryker-mutator/core": "^8.6.0",
    "@stryker-mutator/typescript-checker": "^8.6.0",
    "@stryker-mutator/vitest-runner": "^8.6.0",
    "knip": "^5.38.0",
    "dependency-cruiser": "^16.5.0",
    "husky": "^9.1.0",
    "lint-staged": "^15.2.0",
  },
  "dependencies": {
    "zod": "^3.24.0",
  },
}
```

---

## CI Pipeline Stages

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    # Fast feedback — runs in seconds
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx biome check .

  typecheck:
    # Catches type errors across the entire project
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit

  test:
    # Unit and integration tests with coverage
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx vitest run --coverage
      # Coverage thresholds enforced in vitest.config.ts

  architecture:
    # Dependency rules
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx depcruise src --config .dependency-cruiser.mjs

  dead-code:
    # Unused code, exports, and dependencies
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx knip

  security:
    # Dependency vulnerability scanning
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm audit --audit-level=moderate

  mutation:
    # Slower — run on merge to main only
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx stryker run
```

---

## Quick Start for New Projects

```bash
# 1. Initialize project
mkdir my-project && cd my-project
npm init -y

# 2. Install TypeScript and strict tooling
npm install zod
npm install --save-dev typescript tsx \
  @biomejs/biome \
  vitest @vitest/coverage-v8 fast-check \
  @stryker-mutator/core @stryker-mutator/typescript-checker @stryker-mutator/vitest-runner \
  knip dependency-cruiser \
  husky lint-staged

# 3. Copy configuration files from this guide:
#    - tsconfig.json
#    - biome.json
#    - vitest.config.ts
#    - stryker.config.json
#    - .dependency-cruiser.mjs

# 4. Create project structure
mkdir -p src/{models,services,utils,internal} tests/{unit,integration,helpers}

# 5. Create minimal entry point
echo '/** Package entry point. */' > src/index.ts
echo 'export {};' >> src/index.ts

# 6. Set up pre-commit hooks
git init
npx husky init
echo "npx lint-staged" > .husky/pre-commit

# 7. Verify tools work
npx tsc --noEmit
npx biome check .
npx vitest run
npx knip
```

---

## Tool Mapping Reference (Python → TypeScript)

| Python Tool      | TypeScript Equivalent                   | Purpose                             |
| ---------------- | --------------------------------------- | ----------------------------------- |
| Pyright (strict) | `tsc --strict` + extra flags            | Static type checking                |
| Ruff (linter)    | Biome (or ESLint + typescript-eslint)   | Linting                             |
| Ruff (formatter) | Biome (or Prettier)                     | Code formatting                     |
| Pydantic v2      | Zod                                     | Runtime validation + type inference |
| pytest           | Vitest                                  | Test runner                         |
| hypothesis       | fast-check                              | Property-based testing              |
| mutmut           | Stryker                                 | Mutation testing                    |
| Interrogate      | eslint-plugin-jsdoc + TSDoc             | Documentation coverage              |
| import-linter    | dependency-cruiser                      | Architecture enforcement            |
| Bandit           | eslint-plugin-security                  | Code security scanning              |
| pip-audit        | npm audit                               | Dependency vulnerability scanning   |
| Vulture          | Knip                                    | Dead code detection                 |
| pre-commit       | Husky + lint-staged                     | Git hooks                           |
| Black + isort    | Biome (or Prettier)                     | Formatting + import sorting         |
| `py.typed`       | `"declaration": true` + `"types"` field | Type declaration publishing         |
| `pyproject.toml` | `tsconfig.json` + `package.json`        | Project configuration               |

---

## Pattern Mapping Reference (Python → TypeScript)

| Python Pattern                         | TypeScript Equivalent                          |
| -------------------------------------- | ---------------------------------------------- |
| `Literal["a"] \| Literal["b"]`         | `"a" \| "b"` (string literal union)            |
| `Union[A, B]` with discriminator       | `A \| B` discriminated union on `type` field   |
| `assert_never(x)`                      | `assertNever(x: never): never`                 |
| `NewType("UserId", str)`               | `Brand<string, "UserId">` (branded type)       |
| `Protocol`                             | `interface` (structural typing is the default) |
| `BaseModel` (Pydantic)                 | `z.object({}).strict()` (Zod)                  |
| `Field(description="...")`             | `.describe("...")`                             |
| `model_json_schema()`                  | `zod-to-json-schema`                           |
| `frozen=True`                          | `Readonly<T>` or `as const`                    |
| `extra="forbid"`                       | `.strict()` on Zod schemas                     |
| `from __future__ import annotations`   | Not needed (TypeScript types are erased)       |
| Explicit `as` re-exports in `__init__` | Named exports in barrel `index.ts`             |
| `__all__`                              | Explicit `export { ... }` statements           |
| `@abstractmethod`                      | `abstract` keyword or `interface`              |
| `TypedDict`                            | `interface` or `type` object literal           |
| `# type: ignore[specific-error]`       | `// @ts-expect-error <explanation>`            |

---

## Summary

This configuration creates a TypeScript codebase where:

1. **Every type error is caught before runtime** (`tsc --strict` plus extra flags)
2. **Every style inconsistency is auto-fixed** (Biome)
3. **Every public function is documented** (TSDoc + eslint-plugin-jsdoc)
4. **Every dependency flow is explicit** (dependency-cruiser)
5. **Every security issue is flagged** (eslint-plugin-security + npm audit)
6. **Every code path is tested** (Vitest + v8 coverage thresholds)
7. **Every test actually verifies behavior** (Stryker mutation testing)
8. **Every unused export is detected** (Knip)

The result is a codebase that an AI agent—or a new team member—can navigate, understand, and modify with confidence.

---

## Agent Instructions

When scaffolding a new project using this configuration:

1. **Create `tsconfig.json`** with full strict mode and customize path aliases
2. **Create `biome.json`** (and `eslint.config.mjs` if type-aware rules are needed)
3. **Create the `src/` layout** with path aliases mirrored in bundler config
4. **Set up Zod base schemas** with `.strict()` and `.describe()` patterns
5. **Create test setup** with Vitest configuration and shared fixtures
6. **Set up Husky + lint-staged** for pre-commit hooks
7. **Create `.dependency-cruiser.mjs`** with architecture rules
8. **Run all tools** to verify the setup works

When working in an existing project with this configuration:

1. **Trust the type checker** — If `tsc` says it's wrong, it's wrong
2. **Read doc comments first** — They describe intent, implementation may be wrong
3. **Follow existing patterns** — Grep for similar code before inventing new patterns
4. **Run `npm run check` before committing** — Fix issues before they reach CI
5. **Add tests for new code** — Maintain coverage requirements
6. **Document public interfaces** — Linting will enforce this anyway
7. **Use `unknown` not `any`** — When you truly don't know the type, narrow it safely
8. **Prefer `satisfies` over `as`** — Validate shapes at compile time without losing literal types
