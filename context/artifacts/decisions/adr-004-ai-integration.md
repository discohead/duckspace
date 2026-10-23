# ADR-004: AI Integration Architecture

**Status:** Accepted (Revision 3)
**Date:** 2026-02-04
**Deciders:** duckspace Architecture Team
**Domain:** AI-Powered Analytics for Electron Desktop Application
**Revision Note:** This revision selects the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as the conversation engine, leveraging the user's locally installed Claude Code instance and Claude Max subscription for authentication. The prior revision incorrectly recommended the Anthropic Client SDK. ACP remains correctly identified as the Agent Client Protocol (Zed/JetBrains).

---

## Context

duckspace is a single-user, macOS-first Electron desktop application for local-first data analytics. It embeds DuckDB (analytical queries), LanceDB (vector search), and Dexie.js (reactive UI state via liveQuery) as in-process databases. The application must work offline for local data operations, with network features degrading gracefully.

AI integration is needed to bridge the gap between non-technical users and their data. Specifically, the application requires:

1. **Natural language query generation (text-to-SQL):** Users describe what they want to know in plain English; the system generates and executes SQL against DuckDB, returning results with explanations.

2. **Data exploration assistance:** Given a dataset, the AI suggests analyses worth running -- identifying interesting distributions, correlations, outliers, and trends the user may not think to look for.

3. **Automated insight generation:** After executing queries, the AI interprets results in context -- explaining what the numbers mean, highlighting anomalies, and suggesting follow-up questions.

4. **Contextual help and documentation:** The AI assists with understanding schemas, explaining column semantics, recommending joins, and guiding users through the application's capabilities.

These capabilities require an LLM for generation (text-to-SQL, explanations, suggestions), a tool framework for the LLM to interact with local data (execute queries, explore schemas, assess quality), a retrieval pipeline to ground LLM responses in the user's actual data context (RAG over schemas, past queries, and analysis summaries), and an embedding model for semantic search within that retrieval pipeline.

### Key Technology Landscape

Anthropic ships **two distinct SDK products** for TypeScript/Node.js:

- **Anthropic Client SDK** (`@anthropic-ai/sdk`): A lightweight (~200KB) typed HTTP client for the Messages API. The application implements its own tool execution loop, conversation management, and streaming. Requires a Bring-Your-Own-Key (BYOK) API key with per-token billing.

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): Claude Code packaged as a library. Provides an autonomous agent loop with built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, etc.), native MCP server connections, session management, hook system (PreToolUse, PostToolUse, Stop), and subagent spawning via a Task tool. Authenticates via the user's locally installed Claude Code instance and Claude Max subscription -- no API key management or per-token billing.

Additionally, the **Agent Client Protocol (ACP)** has emerged as a standard for connecting code editors/IDEs to AI coding agents (created by Zed and JetBrains, January 2026). ACP is analogous to LSP but for AI agents -- it defines how editors like Zed, JetBrains IDEs, and VS Code communicate with agents like Claude Code, Gemini CLI, and Copilot. ACP is not an agent-to-agent communication or orchestration protocol.

### Driving Constraints (from Project Constitution)

- **Embedded-Only Databases (Principle 10):** No external database servers. All vector search runs in-process via LanceDB.
- **Single-User, Local-First (Principle 14):** The app works offline for local data. AI features that require network (LLM calls) degrade gracefully; features that can run locally (embedding, schema exploration, cached analyses) must remain available offline.
- **Process Isolation (Principle 12):** Main Process owns database engines and the AI SDK. Worker Threads isolate heavy computation (embedding generation, query execution). Renderer Process owns UI.
- **Arrow-First Data Flow (Principle 9):** Query results flowing through the tool pipeline use Arrow format internally; text conversion happens only at the LLM context boundary.
- **Stream and Scan (Principle 11):** Never load full datasets into LLM context. Use tools to query specific data on demand.
- **macOS-First (Principle 13):** All technology choices must work on macOS with Electron. Bundle size matters for a desktop application.
- **Decision Traceability (Principle 5):** Every design choice documents alternatives considered and rationale.

### User Prerequisites

duckspace assumes the user has:
1. **Claude Code installed locally** -- the Agent SDK leverages it for authentication and execution.
2. **An active Claude Max subscription** -- provides access to Claude models without per-token billing.

These are documented as application requirements and checked at startup.

---

## Decision

The AI integration layer for duckspace uses the following stack:

### 1. Conversation Engine: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Choice: Claude Agent SDK over Anthropic Client SDK.**

The Agent SDK runs in the Electron Main Process and manages all LLM interactions through its autonomous agent loop, configured with duckspace's MCP tools, safety hooks, and session management.

**Why the Agent SDK and not the Client SDK (`@anthropic-ai/sdk`):**

1. **Zero-configuration authentication.** The Agent SDK leverages the user's locally installed Claude Code instance and Claude Max subscription. No API key to obtain, configure, securely store (via `safeStorage`), or rotate. No onboarding wizard for AI setup. The user installs Claude Code, signs in with Claude Max, and duckspace's AI features work immediately.

2. **No cost tracking.** Claude Max is a subscription plan -- no per-token billing. This eliminates an entire feature surface from duckspace: token usage tracking, cumulative cost estimates, spending limits (per-conversation, daily, monthly), cost display in the UI, and budget alert notifications. The Client SDK requires all of these because it uses API-key-based per-token billing.

3. **Native MCP integration.** The Agent SDK discovers and uses MCP tools automatically when servers are configured via `mcpServers`. No manual bridge code to convert MCP tool definitions to Claude tool format, no manual tool dispatch in a loop. duckspace registers its analytics tools on an in-process MCP server and the Agent SDK handles discovery, invocation, and result processing.

4. **Declarative safety via `allowedTools` and hooks.** `allowedTools: ['mcp__duckspace__*']` restricts the agent to only duckspace's MCP tools, cleanly disabling all built-in filesystem/bash tools. PreToolUse hooks provide a centralized second layer for SQL safety (read-only enforcement, query timeouts, row limits). This is equivalent in security to a custom tool loop but more declarative and less code.

5. **Built-in session management.** Resume conversations via session ID, fork conversations for exploratory analysis. Session metadata (IDs, timestamps, labels) stored in Dexie.js. The Agent SDK manages actual conversation state, context window utilization, and history pruning internally.

6. **Subagent support.** The Task tool enables parallel analytics workflows: concurrent analysis of multiple datasets, parallel quality checks across tables, multi-step workflows where independent analyses run simultaneously.

7. **Structured observability via hooks.** PostToolUse hooks forward every tool execution to the Renderer Process for real-time UI display. SessionStart/SessionEnd hooks manage lifecycle events. This is more structured than manually instrumenting a custom tool loop.

**Capabilities:**

- **Streaming responses** via async iterables from `query()`, forwarded to the Renderer Process over Electron IPC for real-time chat display.
- **Autonomous tool execution** -- the Agent SDK decides which MCP tools to invoke, executes them, processes results, and iterates until the task is complete or maxTurns is reached.
- **Tool restriction** via `allowedTools` to limit the agent to only duckspace's MCP tools.
- **Session management** for conversation persistence across app restarts (resume) and exploratory branching (fork).
- **Hook system** for safety enforcement (PreToolUse), observability (PostToolUse), and lifecycle management (SessionStart, SessionEnd, Stop).
- **Model access** via Claude Max subscription -- all Claude models available (Opus 4.5, Sonnet 4, Haiku) without per-model cost considerations.

**Context window budget (200K tokens):**

| Allocation | Tokens | Notes |
|-----------|--------|-------|
| System prompt + tool definitions | ~3,000 | Fixed |
| Cached schema context (RAG) | ~10,000 | Injected before query |
| Retrieved RAG context | ~15,000 | Variable per query |
| Conversation history | ~50,000 | Managed by Agent SDK sessions |
| Reserved for response | ~8,000 | Fixed |
| Remaining buffer | ~114,000 | Safety margin |

The Agent SDK manages context window utilization internally, similar to how Claude Code handles long conversations.

### 2. Tool Framework: MCP Server (In-Process)

**Package:** `@modelcontextprotocol/sdk`

An MCP server runs in-process in the Electron Main Process using `InMemoryTransport` (no subprocess, no stdio). The Agent SDK connects to it natively via the `mcpServers` configuration and discovers all registered tools automatically.

**Why MCP rather than direct tool definitions:** MCP provides an open-standard tool registration protocol that is model-agnostic, supports a growing ecosystem of community tools, enables future extensibility (users connecting their own MCP servers), offers the MCP Inspector for debugging, and allows external agents (the user's Claude Code in their terminal) to connect to duckspace's analytics tools.

**Registered tools:**

| Tool | Purpose |
|------|---------|
| `execute_sql` | Run read-only SQL against DuckDB (with timeout and row limits) |
| `explore_schema` | List tables, columns, and types for a dataset |
| `sample_data` | Retrieve representative rows from a table |
| `describe_statistics` | Column-level statistics (min, max, mean, nulls, distinct count) |
| `suggest_visualization` | Recommend chart type based on data shape and query intent |
| `create_visualization` | Generate Vega-Lite or ECharts specification |
| `search_datasets` | Find relevant datasets by semantic description |
| `assess_data_quality` | Check for nulls, duplicates, outliers, type inconsistencies |
| `save_analysis` | Persist a query and visualization as a saved analysis |

**MCP resources:** Dataset schemas, query results, metadata catalog, and saved analyses exposed as read-only resources the model can reference.

**MCP prompts:** Reusable prompt templates for common workflows (comprehensive dataset analysis, report generation, data exploration).

**SQL safety (defense-in-depth):**
1. **PreToolUse hook:** Intercepts `mcp__duckspace__execute_sql` calls, validates SQL is read-only before execution.
2. **MCP tool handler:** Regex check rejects mutation queries (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE) at the tool implementation level.
3. **DuckDB configuration:** Read-only connection mode as a final safety net.
4. **Query timeout:** 30 seconds, enforced by Worker Thread.
5. **Row limit:** 1,000 rows maximum returned to context.

**Extensibility:** The architecture supports connecting to external MCP servers (subprocess or network transport) in later phases. The user's Claude Code can also connect to duckspace's MCP server from the terminal, enabling command-line analytics.

### 3. Agent Client Protocol (ACP): Not Applicable

**Decision: Skip ACP entirely. No implementation, no partial adoption.**

The Agent Client Protocol is an open protocol created by Zed and JetBrains (January 2026) for connecting code editors and IDEs to AI coding agents. It is analogous to LSP (Language Server Protocol) but for AI agents. ACP defines how editors create conversations, stream responses, approve/deny tool requests, and provide file context to agents.

**Why ACP is irrelevant to duckspace:**

- **duckspace is not an editor or IDE.** ACP's client role (the editor side) is designed for code editors that need to connect to AI coding agents. duckspace is a desktop analytics application.
- **duckspace does not host a coding agent.** ACP's server role (the agent side) is designed for AI coding agents that manipulate code. duckspace hosts a data analytics agent that executes SQL and generates visualizations.
- **ACP's context model is editor-centric.** ACP provides open files, cursor position, and selection as context. These concepts do not apply to a data analytics application.
- **ACP Agent Registry is not relevant.** Users would not invoke "duckspace" from their code editor. duckspace's AI is embedded within the application, not exposed as an external agent.

**Correction from prior ADRs:** The original ADR-004 (revision 1) incorrectly identified ACP as an "Agent Communication Protocol" for multi-agent orchestration. That was confusion with a separate IBM project (github.com/i-am-bee/acp). The actual Agent Client Protocol (agentclientprotocol.com) is an editor-to-agent connection protocol. Revision 2 corrected this identity but retained the incorrect SDK recommendation. This revision (3) corrects both.

**Alternative extensibility path:** If duckspace wants external AI agents (Claude Code, Copilot, Gemini CLI) to access its analytics tools, the correct approach is exposing duckspace's tools as an MCP server -- not implementing ACP. ACP-compatible editors already connect to MCP servers for tool access. This is already covered by the MCP server design above.

### 4. RAG Pipeline: LanceDB + DuckDB Hybrid Search

A retrieval-augmented generation pipeline grounds Claude's responses in the user's actual data context:

**What is embedded and stored in LanceDB:**

| Content Type | Chunking Strategy | Retrieval Use |
|-------------|-------------------|---------------|
| Table schemas | One chunk per table (columns + types + descriptions) | "Which table has sales data?" |
| Column descriptions | Per-column chunks with table context prefix | "Find columns related to revenue" |
| Past SQL queries | Full query as single chunk + natural language description | "Similar queries to current question" |
| Analysis summaries | One chunk per saved analysis with findings | "Past findings about customer churn" |
| Data samples | DuckDB-generated distribution summaries (not raw rows) | "Which table has geographic data?" |

**Hybrid search combining vector and keyword retrieval:**

1. **Vector search** via LanceDB: Query embedding compared against stored embeddings using IVF-PQ approximate nearest neighbor search.
2. **Full-text search** via DuckDB FTS extension: Keyword matching for exact terms, table names, and column names.
3. **Reciprocal rank fusion** merges results from both sources, re-ranks, deduplicates, and fits within the context token budget.

**Progressive context loading:** Start with schema overview injected into the Agent SDK's system prompt; let the agent request detailed schemas, statistics, and samples via MCP tools as needed (lazy loading). This avoids saturating the context window upfront.

### 5. Embedding Model: Local Transformers.js (all-MiniLM-L6-v2)

**Primary model:** `all-MiniLM-L6-v2` (384 dimensions, int8 quantized ONNX)

The embedding model runs locally via Transformers.js in a dedicated Worker Thread:

| Property | Value |
|----------|-------|
| Dimensions | 384 |
| Model size (int8 ONNX) | ~23 MB |
| ONNX Runtime size | ~8 MB |
| Total bundle addition | ~31 MB |
| Inference speed (Apple Silicon) | ~15ms per sentence |
| Batch throughput | ~50-80 embeddings/second |
| Memory footprint | ~80-150 MB in Worker Thread |
| MTEB quality score | 0.630 |

**Architecture:**

- Worker Thread loads the Transformers.js pipeline and caches the ONNX model in `app.getPath('userData')/models/`.
- Embedding requests are queued with backpressure; batch optimization groups concurrent requests.
- Output is Float32Array, which maps directly to Arrow FixedSizeList for zero-copy transfer to LanceDB (Principle 9 compliance).
- Model is bundled in app resources for offline-from-install capability (Principle 14 compliance).

**Model upgrade path:** Settings UI allows downloading alternative models (gte-small, bge-small-en-v1.5, nomic-embed-text-v1.5) to the user data directory. Model switch triggers background re-embedding with a progress indicator.

---

## Alternatives

### Conversation Engine: SDK Selection

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)** | Zero-config auth (Claude Max), native MCP integration, declarative safety via hooks + allowedTools, built-in session management, subagent support, no cost tracking needed | Larger bundle, requires Claude Code + Claude Max installed, agent loop is autonomous (less imperative control) | **Selected** -- auth simplicity, native MCP, and elimination of cost tracking outweigh bundle size |
| Anthropic Client SDK (`@anthropic-ai/sdk`) | ~200KB bundle, full imperative control over tool loop, proven Electron compatibility, works with API key | BYOK API key management, manual tool loop, manual MCP bridge, per-token cost tracking, manual conversation management | Rejected -- unnecessary complexity when user has Claude Max; all its "control" advantages are matched by Agent SDK's allowedTools + hooks |
| Direct API (fetch) | Zero bundle cost, full HTTP control | No type safety, manual streaming/retry/rate-limiting, self-maintained | Rejected -- convenience features of SDK justify bundle cost |
| LangChain | Multi-model abstraction, built-in RAG chains, large community | ~5MB+ bundle, many transitive dependencies, framework constraints, supply chain risk in Electron | Rejected -- multi-model abstraction adds complexity without value for Claude-only use |
| LlamaIndex | Multi-model, built-in index/retrieval engines | ~3MB+ bundle, many transitive dependencies, framework constraints | Rejected -- same rationale as LangChain |

**When would the Client SDK be the better choice?** If duckspace needed to target users without Claude Code or Claude Max (e.g., BYOK API key users), or if it needed multi-provider support (OpenAI, Gemini) behind a unified interface. Neither applies to duckspace.

### Tool Framework

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **MCP (in-process)** | Open standard, extensible, future-proof, MCP Inspector for debugging, growing ecosystem, model-agnostic, external agents can connect | Slightly more setup than direct tool definitions | **Selected** -- standardization and dual-access (internal + external) justify setup |
| Direct Agent SDK tool definitions | Simpler for basic cases, less code | Proprietary to Agent SDK, no external access, no third-party tool ecosystem | Rejected -- MCP provides open-standard tool registration with minimal additional cost |
| Custom tool framework | Full control over design | Reinventing the wheel, no ecosystem, maintenance burden | Rejected -- MCP already solves this problem |

### MCP Transport

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **In-process (InMemoryTransport)** | Zero IPC overhead, shared memory, simple debugging, direct DB access | No process isolation for tools | **Selected** -- process isolation is unnecessary for trusted first-party tools |
| Subprocess (stdio) | Process isolation, easy third-party server support | IPC overhead, subprocess lifecycle management, needs IPC for DB access | Deferred -- supported for user-installed extensions in Phase 6+ |

### Agent Client Protocol (ACP)

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Full ACP server implementation | Would appear in editor agent registries | High effort; duckspace is not a coding agent; ACP's editor context model is irrelevant to analytics | Rejected -- ACP targets editors/IDEs connecting to coding agents |
| ACP client (connect to external agents) | Could use external AI agents from within duckspace | Medium effort; duckspace already has its own embedded AI via Agent SDK | Rejected -- redundant with existing Claude integration |
| **Skip ACP entirely** | Zero effort; correct assessment of applicability | None -- ACP is simply not in duckspace's problem space | **Selected** |

**Note on ACP vs MCP:** ACP and MCP are complementary but distinct. MCP defines what tools/data an AI agent can access. ACP defines how an editor talks to an AI agent. duckspace uses MCP (for tool access) and does not need ACP (no editor-to-agent boundary exists). If external agents want to access duckspace's analytics tools, they connect to duckspace's MCP server -- this is an MCP concern, not ACP.

### Embedding Model Strategy

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Local-only (Transformers.js, all-MiniLM-L6-v2)** | Fully offline, no API cost, deterministic, constitutional compliance, 15ms latency | Lower quality than API models (MTEB 0.630 vs. 0.645+) | **Selected** -- quality gap is marginal for analytics context at expected scale |
| API-only (OpenAI text-embedding-3-small) | Higher quality, no local compute | Violates offline-capable principle (Principle 14), privacy concerns, network dependency | Rejected -- constitutional violation |
| Hybrid dual-column (local + API) | Best of both worlds, graceful degradation | 2x storage, complex routing logic, dual-column LanceDB schema, background sync jobs | Deferred -- YAGNI for initial release |
| 768-dim local model (gte-base) | Better semantic precision | 5x larger model (110 MB), 2x slower inference, marginal benefit at <100K corpus | Rejected -- insufficient benefit at expected scale |
| Python sidecar (sentence-transformers) | Wider model selection, GPU acceleration | Requires Python runtime, dramatically increases bundle/installation complexity | Rejected -- Transformers.js provides equivalent models without Python dependency |

### RAG Pipeline Architecture

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Hybrid search (LanceDB vectors + DuckDB FTS)** | Combines semantic and keyword retrieval, reciprocal rank fusion | More complex than single-source search | **Selected** -- hybrid search covers both semantic similarity and exact keyword matches |
| Vector-only search (LanceDB) | Simpler, single search path | Misses exact keyword matches (table names, column names) | Rejected -- exact matches on identifiers are critical for analytics |
| Keyword-only search (DuckDB FTS) | Simple, deterministic | No semantic understanding; "revenue" won't match "sales amount" | Rejected -- semantic matching is essential for natural language queries |

---

## Consequences

### Positive Consequences

1. **Zero-config AI experience:** Users install Claude Code, sign in with Claude Max, and duckspace's AI features work immediately. No API key wizard, no spending limits configuration, no cost tracking UI.
2. **Grounded AI responses:** The RAG pipeline + MCP tools ensure Claude's responses reference the user's actual data, schemas, and past analyses rather than hallucinating.
3. **Streaming UX:** The Agent SDK's async iterable streaming forwarded via IPC provides a responsive chat experience even for complex multi-step analyses.
4. **Extensible tool ecosystem:** MCP standardization means third-party tools, community MCP servers, and future duckspace extensions all use the same protocol. The user's Claude Code can also connect to duckspace's MCP server from the terminal.
5. **Offline-capable retrieval:** Local embeddings via Transformers.js ensure semantic search works without network connectivity; schema exploration and cached analyses remain fully available offline.
6. **Declarative safety:** PreToolUse hooks + `allowedTools` provide centralized, framework-level safety enforcement for SQL queries. Defense-in-depth with MCP tool handler checks and DuckDB read-only mode.
7. **Constitutional compliance:** All decisions respect the project's immutable principles (embedded-only, local-first, Arrow-first, process isolation, stream-and-scan, macOS-first).
8. **Session persistence:** Agent SDK's built-in session management handles conversation resume and fork natively, with metadata in Dexie.js for the UI.

### Negative Consequences and Mitigations

| Consequence | Impact | Mitigation |
|-------------|--------|-----------|
| **Claude Code prerequisite** | Users must have Claude Code installed locally; duckspace cannot function as a standalone AI app without it | Clear documentation; startup check with guided installation link; non-AI features work without Claude Code |
| **Claude Max subscription required** | Users must have an active Claude Max subscription for AI features | Graceful degradation; detect auth failure and show re-subscription prompt; non-AI features remain available |
| **Offline LLM limitation** | Chat, text-to-SQL, and insight generation require network for Claude API calls (even via Agent SDK) | Graceful degradation: schema exploration, cached analyses, and semantic search remain available offline; clear offline indicator in UI |
| **Agent SDK autonomy** | The autonomous agent loop decides which tools to call, which may feel less controlled than a custom loop | `allowedTools` restricts to MCP-only; PreToolUse hooks intercept every call; PostToolUse hooks provide full visibility; maxTurns limits iterations |
| **Larger bundle size** | Agent SDK is larger than the ~200KB Client SDK | Acceptable for Electron (typical bundles 100-300MB); the elimination of cost tracking, API key management, and MCP bridge code offsets the size |
| **Embedding Worker Thread memory** | ~100 MB additional memory for ONNX runtime + model in Worker Thread | Lazy loading (only allocate on first embedding request); idle termination after 5 minutes; memory budget monitoring |
| **MCP server lifecycle** | In-process server shares fate with Main Process; crash in tool handler could affect the app | Error boundaries around tool handlers; tool execution timeouts; consider moving to subprocess if stability issues arise |
| **Context window budget management** | Complex conversations with large schemas can approach 200K token limit | Agent SDK manages context internally; progressive context loading via MCP tools; session fork for exploration |
| **Single-model dependency** | Architecture is optimized for Claude via Agent SDK | Agent SDK wrapped behind internal conversation service interface; tool definitions are MCP-standard (model-agnostic); if Claude Code supports other models in the future, duckspace benefits automatically |
| **Embedding quality ceiling** | Local all-MiniLM-L6-v2 (MTEB 0.630) is lower quality than API alternatives | Sufficient for expected corpus size (<100K items); hybrid API enrichment can be added later; model upgrade path exists via settings |

### Implementation Phasing

| Phase | AI Capabilities | Dependencies |
|-------|----------------|-------------|
| Phase 4 (MVP AI) | Claude Agent SDK integration, basic chat, `execute_sql` and `explore_schema` tools via MCP, streaming via IPC, session management, startup Claude Code check | Core Electron shell, DuckDB integration |
| Phase 5 (Full AI) | All MCP tools, RAG pipeline with LanceDB hybrid search, visualization tools, conversation history in Dexie.js | LanceDB integration, embedding pipeline |
| Phase 6 (Extensions) | External MCP server support, custom tool registration, prompt template library, expose duckspace MCP server to external agents | Plugin architecture |
| Phase 7 (Advanced) | Subagent-based parallel analytics, multi-step analytical workflows, advanced RAG with re-ranking | Mature plugin ecosystem |

### Operational Considerations

- **Claude Code detection:** At startup, verify Claude Code is installed and the user is authenticated. If not, show a guided setup screen.
- **Auth flow:** No API key storage or management. The Agent SDK handles authentication transparently via the local Claude Code instance.
- **Rate limiting:** Handled by Claude Max subscription terms and the Agent SDK internally.
- **Error handling:** Network failures during streaming are caught and displayed gracefully; partial responses are preserved. Tool execution errors are returned to the agent as MCP error responses for self-correction.
- **Telemetry:** No usage data is sent externally. Session metadata stored locally in Dexie.js for the user's own reference.

### Electron Process Topology for AI

```
Renderer Process               Main Process                Worker Thread
+---------------------+       +------------------------+  +------------------+
| Chat UI             |       | Claude Agent SDK       |  | DuckDB queries   |
| Stream display      | <---> | query() async iterable |  | Data transforms  |
| Tool result display |  IPC  | MCP Server (in-proc)   |--| Embedding gen    |
| Session indicator   |       | PreToolUse hooks       |  | (Transformers.js)|
+---------------------+       | Session manager        |  +------------------+
                               | Dexie.js (metadata)    |
                               +------------------------+
```

---

*ADR-004 | duckspace System Design | AI Integration Architecture*
*Revision 3: 2026-02-04 -- Claude Agent SDK selected as conversation engine; auth via local Claude Code + Claude Max subscription; Client SDK rejected*
*Inputs: claude-sdk-mcp-acp.md (revision 3), embedding-models.md, constitution.yaml*
