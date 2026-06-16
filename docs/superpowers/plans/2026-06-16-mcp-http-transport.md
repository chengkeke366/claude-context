# MCP HTTP (Streamable HTTP) 传输支持 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `claude-context` MCP 服务器添加 Streamable HTTP 传输支持，作为现有 stdio 传输的替代方案，使不支持 stdio 的 MCP 客户端也能通过 HTTP 连接。

**Architecture:** 从现有 `index.ts` 的 `ContextMcpServer` 类中提取服务器创建逻辑为独立的工厂函数 `createMcpServer()`（放入新文件 `server.ts`）。stdio 入口和新增的 HTTP 入口共享此工厂函数。HTTP 入口使用 Express + `StreamableHTTPServerTransport`，支持 Bearer Token 认证和有状态会话管理。

**Tech Stack:** TypeScript, Express 4, @modelcontextprotocol/sdk (^1.12.1), Node.js >= 20

**Spec:** `docs/superpowers/specs/2026-06-16-mcp-http-transport-design.md`

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| 新建 | `packages/mcp/src/server.ts` | MCP 服务器工厂函数 `createMcpServer()`，从 `index.ts` 提取 |
| 修改 | `packages/mcp/src/index.ts` | stdio 入口，改为调用工厂函数 |
| 新建 | `packages/mcp/src/http.ts` | HTTP 入口，Express + StreamableHTTPServerTransport |
| 修改 | `packages/mcp/src/config.ts` | 新增 HTTP 配置字段和帮助文本 |
| 修改 | `packages/mcp/package.json` | 新增 express 依赖、bin 入口、scripts |
| 新建 | `packages/mcp/src/http.auth.test.ts` | HTTP 认证中间件测试 |
| 新建 | `packages/mcp/src/http.session.test.ts` | HTTP 会话管理测试 |

---

### Task 1: 安装依赖

**Files:**
- Modify: `packages/mcp/package.json`

- [ ] **Step 1: 安装 express 和 @types/express**

在 `packages/mcp/` 目录下执行：

```bash
cd packages/mcp && pnpm add express@^4.21.0 && pnpm add -D @types/express@^4.17.21
```

- [ ] **Step 2: 验证安装成功**

```bash
cd packages/mcp && cat package.json | grep -E '"express"|"@types/express"'
```

Expected: 输出包含 `"express": "^4.21.0"` 和 `"@types/express": "^4.17.21"`

- [ ] **Step 3: 提交依赖变更**

```bash
git add packages/mcp/package.json pnpm-lock.yaml
git commit -m "chore(mcp): add express dependency for HTTP transport"
```

---

### Task 2: 更新 package.json（bin + scripts）

**Files:**
- Modify: `packages/mcp/package.json:1-44`

- [ ] **Step 1: 更新 bin 字段为对象格式，添加 http 入口**

将 `packages/mcp/package.json` 中的 `"bin": "dist/index.js"` 替换为：

```json
"bin": {
    "claude-context-mcp": "dist/index.js",
    "claude-context-mcp-http": "dist/http.js"
}
```

- [ ] **Step 2: 添加 HTTP 相关的 npm scripts**

在 `packages/mcp/package.json` 的 `scripts` 中添加：

```json
"start:http": "tsx src/http.ts",
"dev:http": "tsx --watch src/http.ts"
```

- [ ] **Step 3: 验证 TypeScript 编译不报错**

```bash
cd packages/mcp && pnpm typecheck
```

Expected: 无错误（当前阶段仅改了 package.json，不影响 TS 编译）

- [ ] **Step 4: 提交**

```bash
git add packages/mcp/package.json
git commit -m "chore(mcp): add HTTP bin entry and scripts for streamable HTTP transport"
```

---

### Task 3: 提取服务器工厂函数 (`server.ts`)

**Files:**
- Create: `packages/mcp/src/server.ts`

此任务从 `index.ts` 的 `ContextMcpServer` 类中提取所有服务器创建逻辑到独立的工厂函数。

- [ ] **Step 1: 创建 `server.ts` 文件**

创建 `packages/mcp/src/server.ts`，内容如下：

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "@zilliz/claude-context-core";
import { MilvusVectorDatabase } from "@zilliz/claude-context-core";

import { ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";

export interface McpServerInstance {
    server: Server;
    context: Context;
    snapshotManager: SnapshotManager;
    syncManager: SyncManager;
    toolHandlers: ToolHandlers;
}

/**
 * Creates and configures an MCP server instance with all tool handlers.
 *
 * This factory function is shared by both the stdio entry (index.ts) and
 * the HTTP entry (http.ts) to ensure identical server setup regardless of
 * transport.
 *
 * The function is async because it calls validateLegacyZeroEntries() to
 * heal any poisoned snapshot entries from pre-fix MCP versions (Issue #295).
 */
export async function createMcpServer(config: ContextMcpConfig): Promise<McpServerInstance> {
    // Initialize MCP server
    const server = new Server(
        {
            name: config.name,
            version: config.version
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    // Initialize embedding provider
    console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
    console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

    const embedding = createEmbeddingInstance(config);
    logEmbeddingProviderInfo(config, embedding);

    // Initialize vector database
    const vectorDatabase = new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken })
    });

    // Initialize Claude Context
    const context = new Context({
        embedding,
        vectorDatabase,
        collectionNameOverride: config.collectionNameOverride
    });

    // Initialize managers
    const snapshotManager = new SnapshotManager();
    const syncManager = new SyncManager(context, snapshotManager);
    const toolHandlers = new ToolHandlers(context, snapshotManager);

    // Load existing codebase snapshot on startup
    snapshotManager.loadCodebaseSnapshot();

    // Register tool definitions and handlers
    setupTools(server, toolHandlers);

    // One-shot startup healing for legacy 0/0+completed snapshot entries
    // left over from pre-fix MCP versions. Runs before the transport accepts
    // requests so clients never observe the poisoning state. See Issue #295.
    await toolHandlers.validateLegacyZeroEntries();

    return { server, context, snapshotManager, syncManager, toolHandlers };
}

function setupTools(server: Server, toolHandlers: ToolHandlers): void {
    const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


    const search_description = `
Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
`;

    // Define available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "index_codebase",
                    description: index_description,
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: `ABSOLUTE path to the codebase directory to index.`
                            },
                            force: {
                                type: "boolean",
                                description: "Force re-indexing even if already indexed",
                                default: false
                            },
                            splitter: {
                                type: "string",
                                description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                enum: ["ast", "langchain"],
                                default: "ast"
                            },
                            customExtensions: {
                                type: "array",
                                items: {
                                    type: "string"
                                },
                                description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                default: []
                            },
                            ignorePatterns: {
                                type: "array",
                                items: {
                                    type: "string"
                                },
                                description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                default: []
                            }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "search_code",
                    description: search_description,
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: `ABSOLUTE path to the codebase directory to search in.`
                            },
                            query: {
                                type: "string",
                                description: "Natural language query to search for in the codebase"
                            },
                            limit: {
                                type: "number",
                                description: "Maximum number of results to return",
                                default: 10,
                                maximum: 50
                            },
                            extensionFilter: {
                                type: "array",
                                items: {
                                    type: "string"
                                },
                                description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                default: []
                            }
                        },
                        required: ["path", "query"]
                    }
                },
                {
                    name: "clear_index",
                    description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: `ABSOLUTE path to the codebase directory to clear.`
                            }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "get_indexing_status",
                    description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: {
                                type: "string",
                                description: `ABSOLUTE path to the codebase directory to check status for.`
                            }
                        },
                        required: ["path"]
                    }
                },
            ]
        };
    });

    // Handle tool execution
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        switch (name) {
            case "index_codebase":
                return await toolHandlers.handleIndexCodebase(args);
            case "search_code":
                return await toolHandlers.handleSearchCode(args);
            case "clear_index":
                return await toolHandlers.handleClearIndex(args);
            case "get_indexing_status":
                return await toolHandlers.handleGetIndexingStatus(args);

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd packages/mcp && pnpm typecheck
```

Expected: 无编译错误

- [ ] **Step 3: 提交**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): extract server creation into factory function in server.ts"
```

---

### Task 4: 重构 `index.ts` 使用工厂函数

**Files:**
- Modify: `packages/mcp/src/index.ts`

此任务将 `index.ts` 中的 `ContextMcpServer` 类改为使用 `createMcpServer()` 工厂函数，移除重复的服务器创建逻辑。

- [ ] **Step 1: 运行现有测试确保基线正常**

```bash
cd packages/mcp && pnpm test
```

Expected: 所有现有测试通过

- [ ] **Step 2: 重写 `index.ts`**

将 `packages/mcp/src/index.ts` 替换为以下内容（保留 shebang 和 console 重定向，使用工厂函数）：

```typescript
#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpConfig, logConfigurationSummary, showHelpMessage } from "./config.js";
import { createMcpServer, McpServerInstance } from "./server.js";

class ContextMcpServer {
    private config: ReturnType<typeof createMcpConfig>;
    private instance?: McpServerInstance;

    constructor(config: ReturnType<typeof createMcpConfig>) {
        this.config = config;
    }

    async start() {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');

        this.instance = await createMcpServer(this.config);

        const transport = new StdioServerTransport();
        console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

        await this.instance.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log('[SYNC-DEBUG] Server connection established successfully');

        // Start background sync after server is connected
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.instance.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

```bash
cd packages/mcp && pnpm typecheck
```

Expected: 无编译错误

- [ ] **Step 4: 运行现有测试确保重构无回归**

```bash
cd packages/mcp && pnpm test
```

Expected: 所有现有测试通过

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/index.ts
git commit -m "refactor(mcp): use createMcpServer factory in stdio entry point"
```

---

### Task 5: 更新 `config.ts` — 添加 HTTP 配置和帮助文本

**Files:**
- Modify: `packages/mcp/src/config.ts`

- [ ] **Step 1: 在 `ContextMcpConfig` 接口中添加 HTTP 配置字段**

在 `packages/mcp/src/config.ts` 的 `ContextMcpConfig` 接口中，在 `collectionNameOverride` 字段后面添加：

```typescript
    // HTTP transport configuration
    httpPort?: number;
    httpHost?: string;
    authToken?: string;
```

- [ ] **Step 2: 在 `createMcpConfig()` 函数中添加 HTTP 配置解析**

在 `packages/mcp/src/config.ts` 的 `createMcpConfig()` 函数中，在 `collectionNameOverride` 赋值后添加：

```typescript
        // HTTP transport configuration
        httpPort: parseInt(envManager.get('MCP_HTTP_PORT') || '3000', 10),
        httpHost: envManager.get('MCP_HTTP_HOST') || '0.0.0.0',
        authToken: envManager.get('MCP_AUTH_TOKEN'),
```

- [ ] **Step 3: 更新 `showHelpMessage()` 添加 HTTP 环境变量文档**

在 `packages/mcp/src/config.ts` 的 `showHelpMessage()` 函数中，在 `MCP Sync Configuration` 部分之前添加：

```
  HTTP Transport Configuration:
  MCP_HTTP_PORT           HTTP server port (default: 3000)
  MCP_HTTP_HOST           HTTP server bind address (default: 0.0.0.0)
  MCP_AUTH_TOKEN          Bearer token for authentication (optional)

```

同时在 `Examples` 部分末尾添加 HTTP 模式的启动示例：

```
  # Start MCP HTTP server (Streamable HTTP transport)
  OPENAI_API_KEY=sk-xxx MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp-http@latest

  # Start MCP HTTP server with authentication
  OPENAI_API_KEY=sk-xxx MILVUS_TOKEN=your-token MCP_AUTH_TOKEN=your-secret-token npx @zilliz/claude-context-mcp-http@latest
```

- [ ] **Step 4: 更新 `logConfigurationSummary()` 记录 HTTP 配置**

在 `packages/mcp/src/config.ts` 的 `logConfigurationSummary()` 函数中，在现有的配置日志之后、`console.log(\`[MCP] 🔧 Initializing server components...\`);` 之前添加：

```typescript
    if (config.httpPort) {
        console.log(`[MCP]   HTTP Port: ${config.httpPort}`);
        console.log(`[MCP]   HTTP Host: ${config.httpHost || '0.0.0.0'}`);
        console.log(`[MCP]   Auth Token: ${config.authToken ? '✅ Configured' : '❌ Not configured (no auth)'}`);
    }
```

- [ ] **Step 5: 验证 TypeScript 编译通过**

```bash
cd packages/mcp && pnpm typecheck
```

Expected: 无编译错误

- [ ] **Step 6: 运行现有测试**

```bash
cd packages/mcp && pnpm test
```

Expected: 所有现有测试通过

- [ ] **Step 7: 提交**

```bash
git add packages/mcp/src/config.ts
git commit -m "feat(mcp): add HTTP transport configuration (port, host, auth token)"
```

---

### Task 6: 编写 HTTP 认证中间件测试

**Files:**
- Create: `packages/mcp/src/http.auth.test.ts`

先写测试（TDD），为 HTTP 认证中间件编写单元测试。认证中间件是一个纯函数，可以从 HTTP 入口中提取出来独立测试。

- [ ] **Step 1: 创建测试文件**

创建 `packages/mcp/src/http.auth.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthMiddleware } from "./http.js";

// Minimal mock for Express req/res
function mockReq(authHeader?: string): any {
    return {
        headers: {
            authorization: authHeader
        }
    };
}

function mockRes(): any {
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: any) {
            res.body = data;
            return res;
        }
    };
    return res;
}

test("auth middleware: allows request with valid token", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq("Bearer my-secret-token");
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
});

test("auth middleware: rejects request with invalid token", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq("Bearer wrong-token");
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, -32000);
    assert.equal(res.body.error.message, "Unauthorized");
});

test("auth middleware: rejects request without Authorization header", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq(undefined);
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
});

test("auth middleware: rejects request with non-Bearer scheme", () => {
    const middleware = createAuthMiddleware("my-secret-token");
    const req = mockReq("Basic my-secret-token");
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
});
```

- [ ] **Step 2: 运行测试确认失败（函数尚未实现）**

```bash
cd packages/mcp && node --import tsx --test src/http.auth.test.ts
```

Expected: FAIL — `createAuthMiddleware` 不存在于 `./http.js`

- [ ] **Step 3: 提交测试**

```bash
git add packages/mcp/src/http.auth.test.ts
git commit -m "test(mcp): add HTTP auth middleware tests"
```

---

### Task 7: 创建 HTTP 入口 (`http.ts`)

**Files:**
- Create: `packages/mcp/src/http.ts`

- [ ] **Step 1: 创建 `http.ts` 完整实现**

创建 `packages/mcp/src/http.ts`：

```typescript
#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createMcpConfig, logConfigurationSummary } from './config.js';
import { createMcpServer, McpServerInstance } from './server.js';

/**
 * Creates an Express middleware that validates Bearer token authentication.
 * Exported for unit testing.
 */
export function createAuthMiddleware(token: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${token}`) {
            res.status(401).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Unauthorized' },
                id: null
            });
            return;
        }
        next();
    };
}

interface Session {
    transport: StreamableHTTPServerTransport;
    instance: McpServerInstance;
}

/**
 * Creates and configures the Express application for the MCP HTTP server.
 * Exported for testing.
 */
export function createHttpApp(config: {
    authToken?: string;
    sessions: Record<string, Session>;
}): express.Application {
    const app = express();
    app.use(express.json());

    // Token authentication middleware (only when configured)
    if (config.authToken) {
        app.use('/mcp', createAuthMiddleware(config.authToken));
    }

    // POST /mcp — Handle MCP requests
    app.post('/mcp', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        try {
            let session: Session;

            if (sessionId && config.sessions[sessionId]) {
                // Reuse existing session
                session = config.sessions[sessionId];
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // New initialization request: create new MCP server instance and transport
                const mcpConfig = createMcpConfig();
                const instance = await createMcpServer(mcpConfig);

                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (sid) => {
                        config.sessions[sid] = { transport, instance };
                    }
                });

                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && config.sessions[sid]) {
                        console.log(`Session ${sid} closed, cleaning up...`);
                        delete config.sessions[sid];
                    }
                };

                await instance.server.connect(transport);
                instance.syncManager.startBackgroundSync();

                await transport.handleRequest(req, res, req.body);
                return; // Already handled
            } else {
                // Invalid request — no valid session ID
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided'
                    },
                    id: null
                });
                return;
            }

            await session.transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error('Error handling MCP request:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: 'Internal server error' },
                    id: null
                });
            }
        }
    });

    // GET /mcp — SSE stream (server-to-client notifications)
    app.get('/mcp', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !config.sessions[sessionId]) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }

        const { transport } = config.sessions[sessionId];
        await transport.handleRequest(req, res);
    });

    // DELETE /mcp — Terminate session
    app.delete('/mcp', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !config.sessions[sessionId]) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }

        console.log(`Received session termination request for session ${sessionId}`);
        const { transport } = config.sessions[sessionId];
        await transport.handleRequest(req, res);
    });

    return app;
}

// Main execution
async function main() {
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const port = config.httpPort || 3000;
    const host = config.httpHost || '0.0.0.0';

    const sessions: Record<string, Session> = {};
    const app = createHttpApp({
        authToken: config.authToken,
        sessions
    });

    app.listen(port, host, () => {
        console.log(`MCP Streamable HTTP server listening on ${host}:${port}`);
        if (config.authToken) {
            console.log(`Authentication: enabled (Bearer token)`);
        } else {
            console.log(`Authentication: disabled`);
        }
    });

    // Graceful shutdown
    const shutdown = async () => {
        console.log('Shutting down HTTP server...');
        for (const sid in sessions) {
            try {
                await sessions[sid].transport.close();
                delete sessions[sid];
            } catch (error) {
                console.error(`Error closing session ${sid}:`, error);
            }
        }
        console.log('HTTP server shutdown complete');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
cd packages/mcp && pnpm typecheck
```

Expected: 无编译错误

- [ ] **Step 3: 运行认证中间件测试**

```bash
cd packages/mcp && node --import tsx --test src/http.auth.test.ts
```

Expected: 4 个测试全部通过

- [ ] **Step 4: 运行全部测试确保无回归**

```bash
cd packages/mcp && pnpm test
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add packages/mcp/src/http.ts
git commit -m "feat(mcp): add Streamable HTTP transport entry point with Express"
```

---

### Task 8: 编写 HTTP 会话管理测试

**Files:**
- Create: `packages/mcp/src/http.session.test.ts`

- [ ] **Step 1: 创建会话管理测试文件**

创建 `packages/mcp/src/http.session.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { createHttpApp } from "./http.js";

/**
 * Helper: start an Express app on a random port and return the base URL.
 * Returns a cleanup function to close the server.
 */
async function startTestServer(authToken?: string): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
}> {
    const sessions: Record<string, any> = {};
    const app = createHttpApp({ authToken, sessions });

    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({
                baseUrl: `http://127.0.0.1:${addr.port}`,
                close: () => new Promise<void>((res) => server.close(() => res()))
            });
        });
    });
}

test("HTTP: POST /mcp without session ID and non-initialize request returns 400", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1
            })
        });

        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error.code, -32000);
        assert.match(body.error.message, /No valid session ID/);
    } finally {
        await close();
    }
});

test("HTTP: GET /mcp without session ID returns 400", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'GET'
        });

        assert.equal(res.status, 400);
    } finally {
        await close();
    }
});

test("HTTP: DELETE /mcp without session ID returns 400", async () => {
    const { baseUrl, close } = await startTestServer();
    try {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'DELETE'
        });

        assert.equal(res.status, 400);
    } finally {
        await close();
    }
});

test("HTTP: POST /mcp with auth rejects invalid token", async () => {
    const { baseUrl, close } = await startTestServer("secret-token");
    try {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer wrong-token'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'initialize',
                id: 1
            })
        });

        assert.equal(res.status, 401);
    } finally {
        await close();
    }
});

test("HTTP: POST /mcp with auth accepts valid token", async () => {
    const { baseUrl, close } = await startTestServer("secret-token");
    try {
        // This will fail at MCP protocol level (no real MCP server behind),
        // but it should pass the auth middleware (not return 401)
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer secret-token'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1
            })
        });

        // Should NOT be 401 — auth passed
        assert.notEqual(res.status, 401);
    } finally {
        await close();
    }
});

test("HTTP: POST /mcp without auth config skips authentication", async () => {
    const { baseUrl, close } = await startTestServer(); // No auth token
    try {
        const res = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1
            })
        });

        // Should NOT be 401 — no auth configured
        assert.notEqual(res.status, 401);
        // Should be 400 — no valid session ID
        assert.equal(res.status, 400);
    } finally {
        await close();
    }
});
```

- [ ] **Step 2: 运行测试**

```bash
cd packages/mcp && node --import tsx --test src/http.session.test.ts
```

Expected: 6 个测试全部通过

- [ ] **Step 3: 运行全部测试**

```bash
cd packages/mcp && pnpm test
```

Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add packages/mcp/src/http.session.test.ts
git commit -m "test(mcp): add HTTP session management and integration tests"
```

---

### Task 9: 构建验证

**Files:**
- 无新增/修改文件，仅验证

- [ ] **Step 1: 完整构建**

```bash
cd packages/mcp && pnpm build
```

Expected: 编译成功，`dist/` 目录生成 `index.js`、`http.js`、`server.js` 等文件

- [ ] **Step 2: 验证 dist 输出包含新文件**

```bash
ls packages/mcp/dist/*.js
```

Expected: 输出包含 `dist/index.js`、`dist/http.js`、`dist/server.js`

- [ ] **Step 3: 运行全部测试**

```bash
cd packages/mcp && pnpm test
```

Expected: 所有测试通过

- [ ] **Step 4: 提交（如有 lint 修复等改动）**

如果 lint 有修复：

```bash
git add -A && git status
git commit -m "chore(mcp): lint fixes after HTTP transport implementation"
```

如果没有改动，跳过此步。

---

### Task 10: 端到端手动验证

此任务验证 HTTP 服务器能够正常启动和处理请求。

- [ ] **Step 1: 启动 HTTP 服务器**

在一个终端中启动（需要有效的环境变量）：

```bash
cd packages/mcp && MCP_HTTP_PORT=3333 OPENAI_API_KEY=sk-test pnpm start:http
```

Expected: 输出 `MCP Streamable HTTP server listening on 0.0.0.0:3333`

- [ ] **Step 2: 在另一个终端测试基本连通性**

```bash
# 测试无 session ID 的请求应返回 400
curl -s -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | python3 -m json.tool
```

Expected: 返回 `400 Bad Request` 错误

- [ ] **Step 3: 停止服务器**

按 `Ctrl+C` 停止服务器

Expected: 输出 `Shutting down HTTP server...` 然后 `HTTP server shutdown complete`

- [ ] **Step 4: 测试认证模式**

```bash
cd packages/mcp && MCP_HTTP_PORT=3333 MCP_AUTH_TOKEN=test123 OPENAI_API_KEY=sk-test pnpm start:http &
sleep 2

# 无效 token 应返回 401
curl -s -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wrong" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'

# 有效 token 应通过认证（返回非 401）
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test123" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# 停止后台进程
kill %1
```

Expected: 无效 token 返回 `{"error":{"code":-32000,"message":"Unauthorized"}}`，有效 token 返回非 401 状态码

---

## 自审清单

### 1. 规格覆盖检查

| 规格要求 | 对应任务 |
|---------|---------|
| Streamable HTTP 传输 | Task 7 (http.ts) |
| 独立入口/命令 | Task 2 (bin) + Task 7 (http.ts) |
| Bearer Token 认证 | Task 5 (config) + Task 6 (测试) + Task 7 (实现) |
| 工厂函数提取 | Task 3 (server.ts) |
| stdio 入口重构 | Task 4 (index.ts) |
| HTTP 配置（port/host/token） | Task 5 (config.ts) |
| 会话管理（创建/复用/终止） | Task 7 (http.ts) + Task 8 (测试) |
| 后台同步保持一致 | Task 7 (http.ts) — 调用 `startBackgroundSync()` |
| package.json 变更 | Task 1 + Task 2 |
| 错误处理（400/401/500） | Task 7 (http.ts) + Task 6/8 (测试) |
| 优雅关闭 | Task 7 (http.ts shutdown handler) |
| 帮助文本更新 | Task 5 (config.ts) |
| 客户端配置示例 | 在规格文档中已记录 |

### 2. 类型一致性检查

- `McpServerInstance` 接口在 `server.ts` 中定义，在 `index.ts` 和 `http.ts` 中引用 — 一致
- `createMcpServer()` 返回 `Promise<McpServerInstance>` — 两个入口都使用 `await` 调用
- `createMcpConfig()` 返回 `ContextMcpConfig` — 一致
- `createAuthMiddleware()` 在 `http.ts` 中导出，在 `http.auth.test.ts` 中导入 — 一致
- `createHttpApp()` 在 `http.ts` 中导出，在 `http.session.test.ts` 中导入 — 一致

### 3. 占位符扫描

- 无 TBD、TODO、"implement later" 等占位符
- 所有代码步骤包含完整代码
- 所有命令包含预期输出
