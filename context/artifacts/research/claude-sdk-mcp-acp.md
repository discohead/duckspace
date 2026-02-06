# Research Finding: Claude Agent SDK, MCP, and ACP for datspace

**Type:** Research Finding
**Date:** 2026-02-04
**Domain:** AI Integration Architecture for Electron Desktop Application
**Scope:** Evaluate Claude Agent SDK vs Anthropic Client SDK, Model Context Protocol (MCP), Agent Client Protocol (ACP), RAG pipeline architecture, and tool-using agent patterns for an embedded analytics application.

---

## Executive Summary

datspace requires an AI integration layer that enables conversational analytics over local data. The user must be able to chat with their data: ask questions in natural language, receive SQL queries and visualizations, and iterate on analysis. This research evaluates the primary building blocks for that stack within the constraints of a single-user, macOS-first, Electron desktop application with embedded databases (DuckDB, LanceDB, Dexie.js).

Two distinct Anthropic SDK products are evaluated: the **Anthropic Client SDK** (`@anthropic-ai/sdk`), a lightweight typed HTTP client for the Messages API, and the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), which provides Claude Code as a library with autonomous agent loops, built-in tools, native MCP server connections, hooks, and session management. The correct identity of ACP is also established: the **Agent Client Protocol** is an IDE-to-agent connection protocol (created by Zed and JetBrains), not an agent-to-agent communication protocol.

The recommended architecture uses the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as the conversation engine, leveraging the user's locally installed Claude Code instance and Claude Max subscription for authentication. datspace registers its analytics tools as an **in-process MCP server** that the Agent SDK connects to natively. A **LanceDB-powered RAG pipeline** provides context retrieval. **ACP is skipped entirely** as it targets IDE/editor integrations, not desktop analytics applications.

---

## 1. Claude Agent SDK vs Anthropic Client SDK

### 1.1 Product Identity Clarification

Anthropic ships two distinct SDK products for TypeScript/Node.js. They serve different purposes and should not be conflated.

| Attribute | Anthropic Client SDK | Claude Agent SDK |
|-----------|---------------------|------------------|
| **Package** | `@anthropic-ai/sdk` | `@anthropic-ai/claude-agent-sdk` |
| **Purpose** | Typed HTTP client for the Messages API | Claude Code as a library |
| **Abstraction level** | Low-level: send prompts, receive responses | High-level: autonomous agent with built-in tools |
| **Agent loop** | You implement the tool execution loop | Built-in autonomous loop handles tool calls |
| **Built-in tools** | None (you define tools) | Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Task (subagents) |
| **MCP support** | Manual: you call tools and pass results back | Native: connects to any MCP server, uses tools automatically |
| **Conversation management** | Manual: you manage message arrays | Built-in session management (resume, fork) |
| **Streaming** | SSE via `client.messages.stream()` | Async iterables from `query()` |
| **Hook system** | None | PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd |
| **Subagent support** | None (implement yourself) | Task tool for spawning subagents |
| **Backend support** | Anthropic API, Bedrock, Vertex AI | Anthropic API, Bedrock, Vertex AI, Azure |
| **Auth model** | BYOK API key (`ANTHROPIC_API_KEY`) | Local Claude Code instance + Claude Max subscription |
| **Entry point** | `new Anthropic()` then `client.messages.create()` | `query()` function |
| **Skills/commands** | None | Skills, slash commands, permissions model |

### 1.2 Anthropic Client SDK (`@anthropic-ai/sdk`)

The Client SDK is a thin, typed wrapper around the Anthropic Messages API. You send a message array and tool definitions; you receive a response that may contain text or tool_use blocks. If the response includes tool_use, your code must execute the tool and send the result back as a tool_result message. This loop continues until the model responds without tool calls.

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Define tools explicitly
const tools: Anthropic.Tool[] = [
  {
    name: 'execute_sql',
    description: 'Execute a SQL query against the local DuckDB database',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SQL query to execute' },
        database: { type: 'string', description: 'Target database name' },
      },
      required: ['query', 'database'],
    },
  },
];

// Manual tool execution loop
async function chat(userMessage: string, history: Anthropic.MessageParam[]) {
  history.push({ role: 'user', content: userMessage });

  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: history,
      tools,
    });

    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeLocalTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      history.push({ role: 'user', content: toolResults });
    } else {
      break; // Model is done calling tools
    }
  }
}
```

**Key characteristics:**
- ~200KB bundle size (lightweight HTTP client)
- Full control over the tool execution loop, conversation history, streaming, and error handling
- Requires Bring-Your-Own-Key (BYOK) API key management
- You decide what tools exist, how they execute, and how results are formatted
- Streaming via SSE with `client.messages.stream()` returning event emitters
- Automatic retries with exponential backoff for rate limits and transient errors
- Prompt caching, extended thinking, vision, and batches API all supported
- Per-token billing requires cost tracking and spending limits

### 1.3 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

The Agent SDK packages Claude Code's agentic capabilities as a library. Instead of managing tool execution manually, you call `query()` with a prompt and the SDK autonomously decides which tools to use, executes them, and iterates until the task is complete.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// datspace analytics agent
for await (const message of query({
  prompt: 'Analyze the sales dataset and find the top revenue drivers',
  options: {
    maxTurns: 20,
    // Restrict to only MCP tools (disable filesystem/bash built-ins)
    allowedTools: ['mcp__datspace__*'],
    // Connect to datspace's in-process MCP server
    mcpServers: {
      'datspace': {
        transport: 'memory', // in-process via InMemoryTransport
        serverInstance: datspaceMcpServer,
      },
    },
    // Safety enforcement via hooks
    hooks: {
      preToolUse: async (tool, input) => {
        // Log all tool calls for audit trail
        auditLog.append({ tool, input, timestamp: Date.now() });
        return { decision: 'approve' };
      },
      postToolUse: async (tool, input, output) => {
        // Forward tool execution events to Renderer for UI display
        mainWindow.webContents.send('chat:tool-result', {
          tool, input, output,
        });
      },
    },
  },
})) {
  if (message.type === 'text') {
    // Stream text to Renderer
    mainWindow.webContents.send('chat:stream-chunk', { text: message.text });
  } else if (message.type === 'tool_use') {
    // Notify Renderer of tool invocation
    mainWindow.webContents.send('chat:tool-call', {
      tool: message.tool,
      input: message.input,
    });
  }
}
```

**Key characteristics:**
- Autonomous agent loop -- the SDK decides what tools to call and executes them
- Built-in tools for filesystem operations, search, bash execution, web access
- `allowedTools` option restricts which tools are available (can limit to MCP-only)
- Native MCP server connections (configure servers, and tools are automatically available)
- Hook system for pre/post tool execution, session lifecycle events
- Session management: resume conversations via session ID, fork to explore alternatives
- Subagent support via Task tool (spawn child agents for parallel work)
- Permissions model controlling which tools are allowed
- **Auth via locally installed Claude Code**: Uses the user's Claude Max subscription. No BYOK API key required. Authentication is managed by the local Claude Code instance.
- **No per-token billing**: Claude Max subscription covers usage. No cost tracking or spending limits needed in the application.

### 1.4 Evaluation for datspace

| Criterion | Client SDK | Agent SDK | datspace Requirement |
|-----------|-----------|-----------|----------------------|
| **Auth model** | BYOK API key; user must obtain and configure | Local Claude Code + Claude Max subscription; zero configuration | datspace should require minimal setup. Agent SDK's auth-via-subscription eliminates API key management entirely |
| **Tool control** | Full control -- you implement every tool | Agent decides autonomously; `allowedTools` restricts scope | datspace needs ~10 custom analytics tools. Agent SDK's `allowedTools` can restrict to only MCP tools, giving equivalent control |
| **Custom tools** | Define tools via JSON Schema, implement handlers | Connect MCP servers; tools auto-discovered | Both work. Agent SDK's native MCP discovery is simpler -- no manual bridge layer |
| **Built-in tools** | None | Read, Write, Edit, Bash, Glob, Grep, etc. | Most built-in tools are unnecessary for analytics. `allowedTools: ['mcp__datspace__*']` disables them cleanly |
| **Safety** | You enforce all safety in custom loop code | PreToolUse hooks intercept every tool call | Hook-based safety is more declarative and centralized. PreToolUse can enforce read-only SQL, timeouts, row limits at framework level |
| **Streaming** | SSE with event emitters | Async iterables from `query()` | Both work for Electron IPC forwarding. Async iterables are more modern and composable |
| **Conversation persistence** | Manual (full control over history, pruning) | Built-in session management (resume, fork) | Agent SDK sessions handle resume/fork natively. Metadata (session IDs, timestamps) stored in Dexie.js |
| **Cost model** | Per-token billing; requires cost tracking, spending limits, API key storage | Claude Max subscription; no per-token billing | Agent SDK eliminates cost tracking complexity entirely |
| **MCP integration** | Manual bridge: list tools → convert to Claude format → dispatch | Native: configure `mcpServers`, tools auto-discovered | Agent SDK's native MCP is simpler -- no bridge code to maintain |
| **Subagents** | Implement yourself | Task tool built-in | Subagents enable parallel analytics (e.g., analyze multiple datasets concurrently) |
| **Electron compatibility** | Proven (standard Node.js HTTP client) | Runs in Node.js (Electron Main Process compatible) | Both work in Electron. Agent SDK requires local Claude Code installation as a prerequisite |

### 1.5 SDK Selection Rationale

**Recommendation: Use the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)**

The Agent SDK is the correct choice for datspace for the following reasons:

1. **Zero-configuration authentication.** The Agent SDK leverages the user's locally installed Claude Code instance and Claude Max subscription. There is no API key to obtain, configure, store, or rotate. datspace assumes the user has Claude Code installed (a reasonable prerequisite for an AI-powered analytics tool) and the Agent SDK handles authentication transparently. This eliminates an entire category of UX complexity (API key onboarding, secure storage via `safeStorage`, key rotation, invalid key error handling).

2. **Native MCP integration eliminates the bridge layer.** With the Client SDK, datspace would need a manual bridge: call `mcpClient.listTools()`, convert MCP tool definitions to `Anthropic.Tool[]` format, and dispatch tool calls via `mcpClient.callTool()` in the manual loop. With the Agent SDK, you configure `mcpServers` and the SDK discovers and uses tools automatically. This removes ~50-100 lines of bridge code and a maintenance surface.

3. **`allowedTools` provides equivalent safety to a custom tool loop.** The prior analysis argued that the Client SDK's explicit loop is safer. In practice, the Agent SDK's `allowedTools` option achieves the same result declaratively: `allowedTools: ['mcp__datspace__*']` restricts the agent to only datspace's MCP tools, disabling all built-in filesystem/bash tools. PreToolUse hooks add a second layer of safety enforcement (read-only SQL check, timeout enforcement, row limits) at the framework level rather than in application loop code.

4. **Session management aligns with conversation persistence needs.** datspace needs to persist conversations across sessions. The Agent SDK's built-in session management (resume via session ID, fork for exploration) handles this natively. Conversation metadata (session IDs, timestamps, user labels) is stored in Dexie.js, while the Agent SDK manages the actual conversation state. This is simpler than implementing custom message array management, history pruning, and context summarization with the Client SDK.

5. **Claude Max subscription eliminates cost tracking.** With the Client SDK, datspace would need per-token usage tracking, cumulative cost estimates, configurable spending limits, and a cost display in the UI. With the Agent SDK + Claude Max, the subscription covers usage. This removes an entire feature surface (cost tracking, budget alerts, cost display) that adds complexity without user value.

6. **Subagent support enables parallel analytics.** The Agent SDK's Task tool can spawn child agents for parallel work. datspace can use this for concurrent dataset analysis, parallel quality checks across tables, or multi-step analytical workflows where independent analyses run simultaneously.

7. **Hook system provides centralized observability.** PostToolUse hooks forward every tool execution to the Renderer Process for real-time UI display. SessionStart/SessionEnd hooks manage lifecycle events. This is more structured than manually instrumenting a custom tool loop.

**When would the Client SDK be the better choice?** If datspace could not assume Claude Code installation or Claude Max subscription (e.g., if targeting users who only have API keys), the Client SDK's BYOK model would be necessary. If datspace needed to support multiple LLM providers (OpenAI, Gemini) behind a unified interface, the Client SDK's lower-level abstraction would be more appropriate as a base layer.

**Prerequisite:** The user must have Claude Code installed locally and an active Claude Max subscription. This is documented as an application requirement.

---

## 2. Model Context Protocol (MCP)

### 2.1 MCP Overview

MCP is an open protocol (created by Anthropic) that standardizes how AI models interact with external tools, data sources, and prompts. It defines a JSON-RPC 2.0 based communication layer between an MCP client (the AI application) and MCP servers (tool/resource providers).

Key MCP primitives:

| Primitive | Purpose | datspace Usage |
|-----------|---------|------------------|
| **Tools** | Executable functions the model can invoke | SQL query execution, schema exploration, data quality checks, visualization suggestions |
| **Resources** | Data sources the model can read | Dataset schemas, query results, metadata catalog, saved analyses |
| **Prompts** | Reusable prompt templates | Analysis templates, report generation prompts, data exploration workflows |
| **Sampling** | Server-initiated LLM requests | Not needed for datspace (single model) |

### 2.2 MCP Integration with the Claude Agent SDK

Since the recommended SDK is the Agent SDK, MCP integration is native. The Agent SDK discovers MCP tools automatically when servers are configured via the `mcpServers` option.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// 1. Create in-process MCP server with datspace tools
const mcpServer = new McpServer({ name: 'datspace', version: '1.0.0' });
registerAnalyticsTools(mcpServer); // registers execute_sql, explore_schema, etc.

// 2. Pass the MCP server to the Agent SDK — tools are discovered automatically
for await (const message of query({
  prompt: userMessage,
  options: {
    allowedTools: ['mcp__datspace__*'], // Only datspace MCP tools
    mcpServers: {
      'datspace': {
        transport: 'memory',
        serverInstance: mcpServer,
      },
    },
    hooks: {
      preToolUse: sqlSafetyHook,
      postToolUse: uiForwardingHook,
    },
  },
})) {
  forwardToRenderer(message);
}
```

**Key advantages of native MCP integration:**
- No manual tool format conversion (MCP → Claude tool schema)
- No manual tool dispatch bridge code
- Agent SDK handles tool discovery, invocation, and result processing
- MCP resources and prompts are accessible to the agent natively
- Tool namespacing: MCP tools are prefixed (`mcp__datspace__execute_sql`), making `allowedTools` filtering clean

**Note on in-process transport:** The `InMemoryTransport` approach from `@modelcontextprotocol/sdk` connects the MCP server directly within the Electron Main Process. No subprocess management, no stdio pipes, no serialization overhead for tool calls. The MCP server has direct access to DuckDB, LanceDB, and Dexie.js handles in the same process.

### 2.3 MCP Server Implementation: Tool Definitions

datspace requires the following MCP tools:

| Tool | Description | Input | Output |
|------|-------------|-------|--------|
| `execute_sql` | Run SQL against DuckDB | query, database | Query results (tabular) |
| `explore_schema` | List tables, columns, types | database, table? | Schema information |
| `sample_data` | Get sample rows from a table | database, table, limit | Sample rows |
| `describe_statistics` | Column statistics (min, max, mean, nulls) | database, table, column? | Statistical summary |
| `suggest_visualization` | Recommend chart type for data shape | columns, data_types, cardinalities | Chart recommendation |
| `create_visualization` | Generate visualization specification | chart_type, data, options | Vega-Lite or ECharts spec |
| `search_datasets` | Find relevant datasets by description | query | Matching datasets |
| `assess_data_quality` | Check for nulls, duplicates, outliers | database, table | Quality report |
| `save_analysis` | Persist a query/visualization as a saved analysis | name, query, visualization | Confirmation |

```typescript
// Example: execute_sql with safety enforcement via MCP handler + PreToolUse hook
mcpServer.tool(
  'execute_sql',
  'Execute a read-only SQL query against the local DuckDB database',
  {
    query: { type: 'string', description: 'SQL query to execute' },
    database: { type: 'string', description: 'Target database/dataset name' },
  },
  async ({ query, database }) => {
    // Safety: reject mutation queries (defense-in-depth with PreToolUse hook)
    const normalized = query.trim().toUpperCase();
    if (/^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/.test(normalized)) {
      return {
        content: [{ type: 'text', text: 'Error: Only read-only queries are allowed.' }],
        isError: true,
      };
    }

    // Execute via DuckDB worker thread with timeout
    const result = await duckdbWorker.execute(query, database, { timeoutMs: 30000, maxRows: 1000 });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }
);
```

**Defense-in-depth safety model:** SQL safety is enforced at two levels:
1. **MCP tool handler:** Regex check rejects mutation queries at the tool implementation level.
2. **PreToolUse hook:** The Agent SDK's hook system provides a second check before any tool executes, enabling centralized policy enforcement across all tools.

```typescript
const sqlSafetyHook = async (tool: string, input: Record<string, unknown>) => {
  if (tool === 'mcp__datspace__execute_sql') {
    const query = (input.query as string).trim().toUpperCase();
    if (/^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/.test(query)) {
      return { decision: 'deny', reason: 'Mutation queries are not permitted' };
    }
  }
  return { decision: 'approve' };
};
```

### 2.4 Resource Exposure

MCP resources provide read-only context the model can reference:

```typescript
// Dynamic resource: dataset schema
mcpServer.resource(
  'schema://{database}/{table}',
  'Schema for a specific table',
  async (uri) => {
    const { database, table } = parseUri(uri);
    const schema = await duckdbWorker.getSchema(database, table);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(schema),
      }],
    };
  }
);

// Static resource: metadata catalog
mcpServer.resource(
  'catalog://datasets',
  'List of all registered datasets',
  async () => {
    const catalog = await dexieDb.datasets.toArray();
    return {
      contents: [{
        uri: 'catalog://datasets',
        mimeType: 'application/json',
        text: JSON.stringify(catalog),
      }],
    };
  }
);
```

### 2.5 Prompt Template Management

MCP prompts are reusable templates users can select:

```typescript
mcpServer.prompt(
  'analyze_dataset',
  'Comprehensive analysis of a dataset',
  [{ name: 'dataset', description: 'Name of the dataset to analyze', required: true }],
  async ({ dataset }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Perform a comprehensive analysis of the "${dataset}" dataset.
               Start by exploring the schema, then examine data quality,
               identify key patterns, and suggest visualizations.`,
      },
    }],
  })
);
```

### 2.6 MCP Server Lifecycle in Electron

**Option A: In-process MCP server (RECOMMENDED)**

Run the MCP server directly in the Electron Main Process using the in-memory transport. The Agent SDK connects to it via the `mcpServers` configuration.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mcpServer = new McpServer({ name: 'datspace', version: '1.0.0' });
registerAnalyticsTools(mcpServer);
registerResources(mcpServer);
registerPrompts(mcpServer);

// Agent SDK connects to this server instance natively
// No explicit client setup needed -- the SDK handles it
```

**Advantages of in-process:**
- No subprocess lifecycle management
- No IPC serialization overhead for tool calls
- Direct access to DuckDB, LanceDB, Dexie.js handles in the same process
- Simpler debugging and error handling
- Lower memory footprint

**Option B: Subprocess MCP server (for extensions)**

Support connecting to external MCP servers for user-installed extensions:

```typescript
// External MCP servers can be configured alongside the in-process server
mcpServers: {
  'datspace': {
    transport: 'memory',
    serverInstance: mcpServer, // in-process
  },
  'user-extension': {
    command: 'node',
    args: ['/path/to/external-mcp-server.js'], // subprocess
  },
}
```

**Recommendation:** Start with in-process for datspace's own tools. Support connecting to external MCP servers (subprocess or SSE transport) for extensibility in later phases.

### 2.7 MCP with Agent SDK vs Direct Tool Definitions

The Agent SDK supports both MCP tool discovery and direct tool definitions. The question is whether to use MCP at all:

| Aspect | Direct Tool Definitions | MCP Server |
|--------|------------------------|------------|
| **Simplicity** | Simpler for basic cases | More setup required |
| **Standardization** | Proprietary to Agent SDK | Open protocol, tool-agnostic |
| **Extensibility** | Hard to add third-party tools | Designed for plugin ecosystems |
| **Debugging** | Inline tool handlers | MCP Inspector tool available |
| **Future-proofing** | Locked to Agent SDK format | Works with any MCP-compatible model/client |
| **Community** | N/A | Growing ecosystem of MCP servers |
| **External access** | Not possible | External agents (Claude Code, Copilot) can connect to datspace's MCP server |

**Verdict:** Use MCP. The additional setup cost is minimal (especially with in-process transport), and the benefits of standardization, extensibility, and external access are significant. datspace's analytics tools exposed as an MCP server means any MCP-compatible client -- including the user's Claude Code in their terminal -- can connect and query their data.

---

## 3. Agent Client Protocol (ACP)

### 3.1 Correct Protocol Identity

ACP is the **Agent Client Protocol**, an open protocol for connecting code editors and IDEs to AI coding agents. It was created by **Zed** and **JetBrains** and launched in January 2026.

**ACP is NOT an agent-to-agent messaging or orchestration protocol.** A separate IBM project (github.com/i-am-bee/acp) uses a similar acronym for inter-agent messaging, but that is a completely different protocol. datspace should reference the correct ACP.

| Attribute | Agent Client Protocol (ACP) |
|-----------|----------------------------|
| **Created by** | Zed, JetBrains |
| **Purpose** | Connect code editors/IDEs to AI coding agents |
| **Analogy** | LSP (Language Server Protocol) but for AI agents |
| **Transport** | JSON-RPC over stdio (local agents) or HTTP/WebSocket (remote agents) |
| **Relationship to MCP** | Complementary -- MCP defines what data/tools agents access; ACP defines how agents connect to editors |
| **Data type reuse** | Reuses MCP data types where applicable |
| **Supported agents** | Claude Code, Gemini CLI, Auggie, OpenCode, Copilot |
| **SDKs** | Python, TypeScript, Kotlin, Rust |
| **Registry** | ACP Agent Registry (launched January 2026) |
| **Reference** | https://agentclientprotocol.com, https://zed.dev/acp |

### 3.2 ACP Architecture

ACP defines a standardized interface between two roles:

```
+-----------------+        ACP (JSON-RPC)         +------------------+
|  Editor/IDE     | <---------------------------> |  AI Agent        |
|  (ACP Client)   |    stdio / HTTP / WebSocket   |  (ACP Server)    |
|                 |                                |                  |
|  - Zed          |    Capabilities:               |  - Claude Code   |
|  - JetBrains    |    - Create conversation       |  - Gemini CLI    |
|  - VS Code      |    - Send messages             |  - Auggie        |
|  - Any editor   |    - Stream responses          |  - OpenCode      |
|                 |    - Tool approvals            |  - Copilot       |
+-----------------+    - File operations           +------------------+
```

Key ACP capabilities:
- **Conversation management:** Create, resume, and manage AI conversations from the editor
- **Streaming responses:** Real-time text streaming from agent to editor
- **Tool approval flow:** Editor can approve/deny agent tool requests (file writes, bash commands)
- **File context:** Editor provides open files, cursor position, selection as context
- **Agent discovery:** Registry of available agents that editors can connect to

### 3.3 ACP Relevance Assessment for datspace

datspace is a **desktop analytics application**, not a code editor or IDE. The ACP relevance analysis must be evaluated from this perspective.

| Question | Answer | Implication |
|----------|--------|-------------|
| Is datspace an editor/IDE? | No -- it is an analytics application | ACP client role is not applicable |
| Does datspace host a coding agent? | No -- it hosts an analytics/data agent | ACP server role does not naturally fit |
| Does datspace want to appear in editor agent registries? | Unlikely -- users would not invoke "datspace" from their code editor | ACP Agent Registry is not relevant |
| Does datspace embed an AI agent that manipulates code? | No -- its agent executes SQL, explores schemas, generates visualizations | ACP's file/code context model is irrelevant |
| Could datspace expose its analytics agent as an ACP server? | Technically possible but architecturally awkward | Would require mapping SQL/analytics tools to ACP's editor-centric interface |

**Assessment: ACP is not relevant to datspace.**

ACP solves the problem of "how does my editor talk to an AI coding agent?" datspace does not have this problem. Its AI integration is embedded within the application, communicating through Electron IPC and the Agent SDK's native MCP integration. There is no editor-to-agent boundary to standardize.

### 3.4 ACP Compliance Recommendation

**Skip ACP entirely.** ACP does not define task lifecycle states for agent workflows. ACP defines the editor-to-agent communication channel. Adopting "ACP-compatible" naming provides no future compatibility benefit because datspace is not in ACP's problem space.

**Potential future scenario where ACP becomes relevant:**
If datspace adds a code editor component (e.g., a SQL editor pane with AI-assisted SQL writing), it could act as an ACP client connecting to an external AI agent. However, this is speculative and would be better served by the embedded Agent SDK integration already planned.

**Alternative scenario -- exposing datspace as an MCP server:**
A more useful extensibility path is exposing datspace's analytics tools as an MCP server that external ACP-compatible agents (like Claude Code or Copilot) could connect to. This would let developers query their datspace datasets from their code editor. This is an MCP concern, not an ACP concern, and is already covered by the MCP server design in Section 2.

---

## 4. RAG Pipeline Architecture

### 4.1 Pipeline Overview

datspace's RAG pipeline retrieves relevant context (schemas, data samples, past analyses) to ground Claude's responses in the user's actual data.

```
User Query
    |
    v
+------------------+
| Query Analysis   |  Determine what context is needed
+------------------+
    |
    v
+------------------+
| Embedding        |  Generate query embedding
| Generation       |  (local model via Transformers.js)
+------------------+
    |
    v
+------------------+
| Vector Search    |  Search LanceDB for similar
| (LanceDB)       |  schemas, past queries, docs
+------------------+
    |
    v
+------------------+
| Full-Text Search |  Keyword search in metadata
| (DuckDB FTS)    |  for exact matches
+------------------+
    |
    v
+------------------+
| Context Assembly |  Rank, deduplicate, and fit
|                  |  retrieved context into budget
+------------------+
    |
    v
+------------------+
| Agent Query      |  Agent SDK query() with
| (Agent SDK)      |  system prompt + RAG context
+------------------+
    |
    v
+------------------+
| Autonomous Tools |  Agent uses MCP tools to
| (MCP Server)     |  execute SQL, explore, viz
+------------------+
```

### 4.2 What to Embed and Store in LanceDB

| Content Type | Chunking Strategy | Embedding Model | Retrieval Use |
|-------------|-------------------|-----------------|---------------|
| **Table schemas** | One chunk per table (columns + types + descriptions) | local all-MiniLM-L6-v2 | "Which table has sales data?" |
| **Column descriptions** | One chunk per column with table context | Same | "Find columns related to revenue" |
| **Past queries** | One chunk per saved SQL query + natural language description | Same | "Similar queries to what the user is asking" |
| **Analysis summaries** | One chunk per saved analysis with findings | Same | "Past findings about customer churn" |
| **Data samples** | Representative row samples (5-10 rows per table) | Same | Provide data format context |

### 4.3 Embedding Strategy

**Local embeddings via Transformers.js** (see `embedding-models.md` for full analysis):

- **Model:** `all-MiniLM-L6-v2` (384 dimensions, int8 quantized ONNX)
- **Execution:** Worker Thread in Electron Main Process
- **Latency:** ~15ms per sentence on Apple Silicon
- **Bundle:** ~31 MB (model + ONNX Runtime)
- **Quality:** MTEB 0.630 -- sufficient for analytics-context retrieval at expected scale (<100K items)

Local-only embedding is the default. API-based enrichment can be added as a dual-column enhancement in a later phase without architectural changes.

### 4.4 Context Window Management

With Claude's 200K token context window, budget allocation for an analytics conversation:

```
Total budget: 200,000 tokens
  |
  +-- System prompt + tool definitions:    3,000 tokens (fixed)
  +-- Cached schema context:              10,000 tokens (cached, near-free)
  +-- Retrieved RAG context:              15,000 tokens (variable)
  +-- Conversation history:               50,000 tokens (grows)
  +-- Reserved for response:               8,000 tokens (fixed)
  +-- Remaining buffer:                  114,000 tokens
```

**Strategies to stay within budget:**
1. **Progressive context:** Start with schema overview in the system prompt; let the agent request detailed schemas via MCP tools as needed (lazy loading).
2. **Selective retrieval:** Only retrieve RAG context relevant to the current query, not everything.
3. **Session management:** Agent SDK's session resume handles conversation continuity. Long conversations can be forked for exploration without polluting the main session.
4. **Agent SDK context management:** The SDK internally manages context window utilization, similar to how Claude Code handles long conversations.

### 4.5 Hybrid Search

Combine vector similarity search with keyword-based search for best results:

```typescript
async function hybridSearch(query: string, topK: number = 10): Promise<Context[]> {
  // Vector search via LanceDB
  const queryEmbedding = await generateEmbedding(query);
  const vectorResults = await lancedb
    .openTable('context_chunks')
    .search(queryEmbedding)
    .limit(topK)
    .execute();

  // Full-text search via DuckDB
  const ftsResults = await duckdb.execute(`
    SELECT * FROM fts_main_context.search_context('${escapeSql(query)}')
    LIMIT ${topK}
  `);

  // Reciprocal rank fusion to merge results
  return reciprocalRankFusion(vectorResults, ftsResults, topK);
}
```

---

## 5. Tool-Using Agent Patterns for Analytics

### 5.1 SQL Query Generation and Execution

The core tool pattern for datspace:

```
User: "What were our top 10 products by revenue last month?"
    |
    v
Agent SDK calls MCP tool:
  mcp__datspace__execute_sql({
    query: "SELECT product_name, SUM(revenue) as total_revenue
            FROM sales
            WHERE sale_date >= '2026-01-01'
            GROUP BY product_name
            ORDER BY total_revenue DESC
            LIMIT 10",
    database: "analytics"
  })
    |
    v
Tool returns results as Arrow table -> JSON summary
    |
    v
Agent presents findings with visualization suggestion
```

**Safety enforcement (defense-in-depth):**
1. **PreToolUse hook:** Intercepts tool call, validates SQL is read-only
2. **MCP tool handler:** Regex check rejects mutation queries
3. **DuckDB configuration:** Read-only connection mode as final safety net
4. **Query timeout:** 30 seconds, enforced by Worker Thread
5. **Row limit:** 1,000 rows maximum returned to context

### 5.2 Data Visualization Suggestion Tool

```typescript
mcpServer.tool(
  'suggest_visualization',
  'Recommend the best chart type for given data characteristics',
  {
    columns: { type: 'array', items: { type: 'object' }, description: 'Column definitions' },
    row_count: { type: 'number', description: 'Number of rows in the result' },
    query_intent: { type: 'string', description: 'What the user is trying to understand' },
  },
  async ({ columns, row_count, query_intent }) => {
    const recommendation = analyzeDataShape(columns, row_count, query_intent);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          chart_type: recommendation.type,
          encoding: recommendation.encoding,
          rationale: recommendation.rationale,
        }),
      }],
    };
  }
);
```

### 5.3 Schema Exploration Tools

Provide multiple granularity levels:

| Tool | When Used | Output |
|------|-----------|--------|
| `list_databases` | Start of conversation | Available databases/datasets |
| `explore_schema` | User asks about a dataset | Tables, columns, types |
| `describe_statistics` | Detailed column analysis | Min, max, mean, nulls, distinct count |
| `sample_data` | Understanding data format | 5-10 representative rows |
| `explain_relationships` | Understanding joins | Foreign key relationships, join paths |

### 5.4 Data Quality Analysis Tools

```typescript
mcpServer.tool(
  'assess_data_quality',
  'Analyze data quality issues in a table',
  {
    database: { type: 'string' },
    table: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' }, description: 'Specific columns (optional)' },
  },
  async ({ database, table, columns }) => {
    const checks = await Promise.all([
      checkNullPercentages(database, table, columns),
      checkDuplicateRows(database, table),
      checkOutliers(database, table, columns),
      checkCardinalityAnomalies(database, table, columns),
      checkDataTypeConsistency(database, table, columns),
    ]);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          overall_score: calculateQualityScore(checks),
          issues: checks.flatMap(c => c.issues),
          recommendations: generateRecommendations(checks),
        }),
      }],
    };
  }
);
```

### 5.5 Agentic Loop Pattern

With the Agent SDK, the agentic loop is handled by the SDK itself. datspace's role is to:

1. **Prepare RAG context** before the agent query
2. **Configure the agent** with MCP servers, allowed tools, and hooks
3. **Stream results** to the Renderer Process
4. **Persist session metadata** in Dexie.js

```typescript
async function analyticsChat(userMessage: string, sessionId?: string) {
  // 1. Retrieve relevant context via RAG
  const ragContext = await hybridSearch(userMessage);

  // 2. Build system prompt with RAG context
  const systemPrompt = buildSystemPrompt(ragContext);

  // 3. Agent SDK handles the entire agentic loop
  const queryOptions = {
    prompt: userMessage,
    options: {
      systemPrompt,
      maxTurns: 20,
      allowedTools: ['mcp__datspace__*'],
      mcpServers: {
        'datspace': {
          transport: 'memory',
          serverInstance: mcpServer,
        },
      },
      hooks: {
        preToolUse: sqlSafetyHook,
        postToolUse: async (tool, input, output) => {
          // Forward to Renderer for real-time tool display
          mainWindow.webContents.send('chat:tool-result', { tool, input, output });
        },
      },
      // Resume existing session or start new one
      ...(sessionId ? { sessionId } : {}),
    },
  };

  // 4. Stream agent output to Renderer
  let newSessionId: string | undefined;
  for await (const message of query(queryOptions)) {
    if (message.type === 'text') {
      mainWindow.webContents.send('chat:stream-chunk', { text: message.text });
    } else if (message.type === 'session') {
      newSessionId = message.sessionId;
    }
  }

  // 5. Persist session metadata in Dexie.js
  if (newSessionId) {
    await dexieDb.sessions.put({
      id: newSessionId,
      lastMessage: userMessage,
      updatedAt: new Date(),
    });
  }

  return newSessionId;
}
```

The Agent SDK autonomously:
- Decides which MCP tools to invoke
- Executes tools and processes results
- Iterates until the task is complete or maxTurns is reached
- Manages context window internally
- Handles streaming and tool result formatting

datspace's code is declarative (configure and stream) rather than imperative (loop and dispatch).

---

## 6. Alternatives Considered

### 6.1 Claude Agent SDK vs Anthropic Client SDK

| Factor | Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Client SDK (`@anthropic-ai/sdk`) |
|--------|----------------------------------------------|----------------------------------|
| Auth model | Local Claude Code + Claude Max (zero config) | BYOK API key (requires key management) |
| Tool control | `allowedTools` + PreToolUse hooks (declarative) | Manual loop (imperative, full control) |
| Built-in tools | Disable via allowedTools | None (no overhead) |
| MCP integration | Native (`mcpServers` config) | Manual bridge (~50-100 lines) |
| Agent loop | Automatic (SDK-managed) | Manual (application code) |
| Safety | Hooks (declarative, centralized) | Loop code (imperative, per-call) |
| Conversation persistence | Built-in sessions + Dexie.js metadata | Manual message array + Dexie.js |
| Cost model | Claude Max subscription (no tracking) | Per-token billing (needs tracking) |
| Subagents | Task tool built-in | Implement yourself |
| Streaming | Async iterables | SSE event emitters |
| Bundle size | Larger (includes tool impls) | ~200KB |
| Electron tested | Compatible (Node.js) | Well-tested |
| Prerequisite | Claude Code + Claude Max installed | API key |

**Verdict:** Agent SDK. The zero-configuration auth, native MCP integration, declarative safety via hooks, built-in session management, and elimination of cost tracking complexity outweigh the larger bundle size and requirement for local Claude Code installation.

### 6.2 Claude Agent SDK vs LangChain vs LlamaIndex

| Factor | Claude Agent SDK | LangChain | LlamaIndex |
|--------|-----------------|-----------|------------|
| Bundle size | Moderate | ~5MB+ (many deps) | ~3MB+ |
| Electron compat | Node.js native | Works but heavy | Works but heavy |
| Abstraction level | High (autonomous agent) | High (chains, agents) | High (indices, engines) |
| Model lock-in | Claude only | Multi-model | Multi-model |
| Dependency risk | Anthropic official | Community, many transitive deps | Community, many transitive deps |
| MCP support | Native | Community adapters | Community adapters |
| Auth | Claude Max (zero config) | Per-provider API keys | Per-provider API keys |

**Verdict:** Use Claude Agent SDK directly. datspace is committed to Claude as the AI model. Multi-model abstraction adds complexity without value. The Agent SDK's native MCP integration and Claude Max auth provide a simpler stack than LangChain/LlamaIndex with their heavy dependency trees.

### 6.3 MCP In-Process vs Subprocess

| Factor | In-Process | Subprocess |
|--------|------------|------------|
| Latency | Near-zero (function calls) | IPC overhead (stdio/pipe) |
| Memory | Shared memory space | Separate process memory |
| Isolation | None (crash affects main) | Full process isolation |
| DB access | Direct handle sharing | Needs IPC for DB access |
| Extensibility | Hard to add third-party | Easy third-party servers |

**Verdict:** In-process for datspace's own tools. Support external subprocess MCP servers for user-installed extensions.

### 6.4 ACP vs No ACP

| Option | Effort | Value for datspace |
|--------|--------|---------------------|
| Full ACP server implementation | High | None -- datspace is not an IDE/editor |
| ACP client (connect to external agents) | Medium | Minimal -- datspace has its own embedded AI |
| Skip ACP entirely | None | Correct -- ACP solves editor-to-agent connectivity, which is not datspace's problem |

**Verdict:** Skip ACP. It targets a different application category (editors/IDEs). datspace should focus on MCP for tool interoperability instead.

### 6.5 Embedding Models

| Model | Quality | Latency | Cost | Offline |
|-------|---------|---------|------|---------|
| Local all-MiniLM-L6-v2 (ONNX) | Good (0.630) | ~15ms | Free | Yes |
| Local gte-small (ONNX) | Good (0.642) | ~18ms | Free | Yes |
| Local nomic-embed-text (ONNX) | Better (0.680) | ~40ms | Free | Yes |
| OpenAI text-embedding-3-small | High (0.625) | ~100ms | $0.02/1M | No |
| OpenAI text-embedding-3-large | Very High (0.645) | ~150ms | $0.13/1M | No |

**Verdict:** Default to local `all-MiniLM-L6-v2` via Transformers.js in a Worker Thread. Fully offline, constitutional compliance, sufficient quality for analytics-context retrieval at expected scale (<100K items).

---

## Recommendation

### Architecture Decision Record

**Decision:** Implement the AI integration layer with the following stack:

1. **Conversation Engine: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)**
   - Run in Electron Main Process
   - Leverages the user's locally installed Claude Code instance for authentication
   - Authentication via Claude Max subscription -- no BYOK API key, no cost tracking
   - `query()` function provides async iterable streaming to Renderer via IPC
   - `allowedTools: ['mcp__datspace__*']` restricts agent to datspace's MCP tools
   - PreToolUse hooks enforce SQL safety (read-only, timeouts, row limits)
   - PostToolUse hooks forward tool events to Renderer for real-time UI display
   - Built-in session management for conversation persistence (resume, fork)
   - Session metadata stored in Dexie.js (session IDs, timestamps, labels)
   - **Why not the Anthropic Client SDK (`@anthropic-ai/sdk`):** The Client SDK requires BYOK API key management, manual tool execution loops, manual MCP-to-Claude bridge code, and per-token cost tracking. These are unnecessary complexities when the user has Claude Max + local Claude Code. The Agent SDK eliminates all of these with zero-config auth, native MCP discovery, declarative hook-based safety, and subscription billing.

2. **Tool Framework: MCP Server (in-process)**
   - Use `@modelcontextprotocol/sdk` with `InMemoryTransport`
   - Register analytics tools: SQL execution, schema exploration, data quality, visualization suggestion
   - Agent SDK discovers and uses MCP tools natively via `mcpServers` config
   - Expose datasets, schemas, and metadata as MCP Resources
   - Define analysis prompt templates as MCP Prompts
   - Support external MCP servers for extensibility (Phase 6+)
   - **Dual benefit:** datspace's MCP server is also accessible to the user's Claude Code in their terminal, enabling "query my data from the command line"

3. **Agent Client Protocol (ACP): Not applicable**
   - ACP is an editor-to-agent connectivity protocol (Zed, JetBrains)
   - datspace is a desktop analytics application, not an IDE/editor
   - No ACP implementation planned for any phase
   - If datspace wants external agents to access its data, expose an MCP server instead

4. **RAG Pipeline: LanceDB + DuckDB hybrid search**
   - Embed schemas, queries, and analysis summaries in LanceDB
   - Full-text search via DuckDB FTS extension for keyword matching
   - Reciprocal rank fusion to merge vector + keyword results
   - RAG context injected into Agent SDK system prompt before each query
   - Default to local embeddings (Transformers.js, all-MiniLM-L6-v2)

5. **Model Selection Strategy**
   - Agent SDK uses the model configured by the user's Claude Code instance
   - Claude Max subscription provides access to all Claude models
   - datspace can specify preferred model via Agent SDK options if supported
   - No per-model cost optimization needed (subscription model)

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

### Key Design Principles

- **Stream and Scan applies to AI too:** Never load entire datasets into LLM context. Use MCP tools to query specific data on demand.
- **Arrow in the loop:** Query results flowing from DuckDB through the tool pipeline should use Arrow format internally, converting to text only for the LLM context.
- **Zero-config AI:** The user installs Claude Code, signs in with Claude Max, and datspace's AI features work immediately. No API key management, no spending limits, no onboarding wizard for AI.
- **Offline-graceful:** Chat features degrade gracefully without network. Schema exploration and cached analyses remain available offline via local embeddings and cached data. A clear offline indicator appears in the UI.
- **Progressive complexity:** Start with simple schema-aware chat. Add RAG, then multi-tool agentic loops, then visualization generation across roadmap phases.
- **Declarative safety:** PreToolUse hooks enforce safety rules (read-only SQL, timeouts, row limits) declaratively at the framework level, complemented by defense-in-depth checks in MCP tool handlers.

### Implementation Phasing

| Phase | Capabilities |
|-------|-------------|
| **Phase 4** (MVP AI) | Claude Agent SDK integration, basic chat, `execute_sql` and `explore_schema` tools via MCP, streaming via IPC, session management |
| **Phase 5** (Full AI) | All MCP tools, RAG pipeline with LanceDB, hybrid search, visualization tools, conversation history in Dexie.js |
| **Phase 6** (Extensions) | External MCP server support, custom tool registration, prompt template library, expose datspace MCP server to external agents |
| **Phase 7** (Advanced) | Subagent-based parallel analytics, multi-step analytical workflows, advanced RAG with re-ranking |

### Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude Code not installed | Clear prerequisite documentation; detect on app startup and guide user to install |
| Claude Max subscription lapsed | Graceful degradation; detect auth failure and show re-subscription prompt |
| Agent SDK compatibility with Electron | Agent SDK runs on Node.js (Electron Main Process is Node.js); test during Phase 4 |
| Agent autonomy concerns | `allowedTools` restricts to MCP-only; PreToolUse hooks provide second safety layer; no filesystem/bash access |
| Context window overflow | Agent SDK manages context internally; RAG provides progressive loading; session fork for exploration |
| MCP protocol evolution | MCP is versioned; pin to stable version; abstract transport layer |
| Agent SDK breaking changes | Pin SDK version; abstract behind internal conversation service interface |
| Network dependency for LLM | Offline indicator in UI; schema exploration and cached analyses remain available; local embeddings for search |

---

*Research conducted: 2026-02-04*
*Revision: 3 (corrected SDK recommendation: Claude Agent SDK chosen over Client SDK; auth via local Claude Code + Claude Max subscription)*
*Applicable to: datspace System Design, Phases 4-7*
*Constraints applied: Single-user, macOS-first, Electron, embedded databases, Arrow-first data flow*
