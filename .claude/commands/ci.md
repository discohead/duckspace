Simulate the GitHub Actions CI pipeline locally by running all checks from `.github/workflows/ci.yml`.

Run each CI job in the same order as the workflow. Track results with a todo list and report a summary table at the end.

## Jobs to Run

Run these 6 jobs sequentially. For each job, mark it in-progress before starting and completed/failed when done.

### 1. lint

```bash
npx biome check .
```

If biome passes, continue to eslint:

```bash
npx eslint .
```

Both must exit 0 for this job to pass.

### 2. typecheck

```bash
npx tsc --noEmit
```

### 3. test

```bash
npx vitest run
```

Note: CI runs with `--coverage` but locally we skip it for speed unless `$ARGUMENTS` includes `--coverage`.

### 4. architecture

```bash
npx depcruise src --config .dependency-cruiser.mjs
```

### 5. dead-code

```bash
npx knip
```

### 6. security

```bash
npm audit --audit-level=moderate || true
```

This job always passes (matches CI behavior with `|| true`).

## Reporting

After all jobs complete, print a summary table:

```
| Job          | Status |
|--------------|--------|
| lint         | ...    |
| typecheck    | ...    |
| test         | ...    |
| architecture | ...    |
| dead-code    | ...    |
| security     | ...    |
```

If any job failed, list the specific errors and suggest fixes.

## Arguments

- Pass `--coverage` to include test coverage (matches CI exactly)
- Pass `--fix` to auto-fix lint issues before checking (`npx biome check --fix . && npx eslint --fix .`)
- Pass `--quick` to run only lint + typecheck (skip slower jobs)
