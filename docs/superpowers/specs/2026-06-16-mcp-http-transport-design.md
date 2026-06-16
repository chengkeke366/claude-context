# MCP HTTP (Streamable HTTP) 传输支持设计

## 概述

为 `claude-context` MCP 服务器添加 **Streamable HTTP** 传输支持，作为现有 stdio 传输的替代方案。主要目的是提升协议兼容性，使不支持 stdio 的 MCP 客户端（如远程连接场景）也能使用本服务。

## 动机

- 当前服务器仅支持 stdio 传输，部分 MCP 客户端只支持 HTTP/SSE 传输
- Streamable HTTP 是 MCP 协议的新标准传输方式，取代了旧版 SSE
- 需要支持远程 HTTP 连接，使客户端可以通过网络连接到 MCP 服务器

## 设计目标

1. 新增 Streamable HTTP 传输模式，与 stdio 模式并行存在
2. 独立的 HTTP 入口点（命令），不影响现有 stdio 功能
3. 支持 Bearer Token 认证
4. 后台同步行为与 stdio 模式保持一致
5. 最小化对现有代码的改动

## 架构

### 方案选择

采用 **独立入口 + 最小重构** 方案：

- 从 `index.ts` 中提取服务器创建逻辑为工厂函数 `createMcpServer()`
- stdio 入口 (`index.ts`) 和 HTTP 入口 (`http.ts`) 共享工厂函数
- HTTP 入口使用 Express + `StreamableHTTPServerTransport`

### 文件结构

```
packages/mcp/
├── src/
│   ├── index.ts          ← 现有 stdio 入口（小改：调用工厂函数）
│   ├── http.ts           ← 新增 HTTP 入口
│   ├── server.ts         ← 新增：服务器工厂函数
│   ├── config.ts         ← 小改：新增 HTTP 相关配置
│   ├── handlers.ts       ← 不变
│   ├── sync.ts           ← 不变
│   ├── snapshot.ts       ← 不变
│   ├── embedding.ts      ← 不变
│   └── ...
├── package.json          ← 新增 express 依赖 + http bin 入口
└── ...
```

### 数据流

```
客户端 → HTTP POST /mcp
       → Express
       → Token 认证中间件（可选）
       → StreamableHTTPServerTransport
       → MCP Server（通过 createMcpServer 创建）
           ├── ToolHandlers
           ├── SyncManager
           └── SnapshotManager
```

## 详细设计

### 1. 服务器工厂函数 (`server.ts`)

从 `index.ts` 的 `ContextMcpServer` 类中提取核心创建逻辑：

```typescript
// server.ts
export interface McpServerInstance {
    server: Server;
    syncManager: SyncManager;
    snapshotManager: SnapshotManager;
    toolHandlers: ToolHandlers;
}

export async function createMcpServer(config: ContextMcpConfig): Promise<McpServerInstance> {
    // 1. 创建 MCP Server 实例（名称、版本、capabilities）
    // 2. 初始化 embedding provider
    // 3. 初始化 Milvus 向量数据库
    // 4. 初始化 Context
    // 5. 初始化 SnapshotManager、SyncManager、ToolHandlers
    // 6. 注册 ListToolsRequest 和 CallToolRequest 处理器
    // 7. 加载代码库快照
    // 8. 验证并修复遗留快照条目（validateLegacyZeroEntries）
    return { server, syncManager, snapshotManager, toolHandlers };
}
```

> **注意：** 工厂函数是 `async` 的，因为内部需要调用 `validateLegacyZeroEntries()` 来修复遗留快照数据。调用方必须 `await` 此函数。

### 2. stdio 入口改动 (`index.ts`)

`ContextMcpServer` 类改为内部调用 `createMcpServer()`。由于工厂函数是异步的（内部执行 `validateLegacyZeroEntries`），构造函数中存储 config，在 `start()` 中调用工厂函数：

```typescript
// index.ts 改动后
class ContextMcpServer {
    private config: ContextMcpConfig;
    private instance?: McpServerInstance;

    constructor(config: ContextMcpConfig) {
        this.config = config;
    }

    async start() {
        this.instance = await createMcpServer(this.config);
        const transport = new StdioServerTransport();
        await this.instance.server.connect(transport);
        this.instance.syncManager.startBackgroundSync();
    }
}
```

### 3. HTTP 入口 (`http.ts`)

独立的 HTTP 入口文件，使用 Express 框架：

```typescript
// http.ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, McpServerInstance } from './server.js';
import { createMcpConfig, ContextMcpConfig } from './config.js';

const MCP_PORT = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
const MCP_HOST = process.env.MCP_HTTP_HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const app = express();
app.use(express.json());

// Token 认证中间件（仅在配置了 AUTH_TOKEN 时启用）
if (AUTH_TOKEN) {
    app.use('/mcp', (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
            res.status(401).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Unauthorized' },
                id: null
            });
            return;
        }
        next();
    });
}

// 会话存储
interface Session {
    transport: StreamableHTTPServerTransport;
    instance: McpServerInstance;
}
const sessions: Record<string, Session> = {};

// POST /mcp — 处理 MCP 请求
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let session: Session;

        if (sessionId && sessions[sessionId]) {
            // 复用已有会话
            session = sessions[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // 新的初始化请求：创建新的 MCP 服务器实例和传输
            const config = createMcpConfig();
            const instance = await createMcpServer(config);

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    sessions[sid] = { transport, instance };
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && sessions[sid]) {
                    delete sessions[sid];
                }
            };

            await instance.server.connect(transport);
            instance.syncManager.startBackgroundSync();

            await transport.handleRequest(req, res, req.body);
            return;
        } else {
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
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

// GET /mcp — SSE 流（服务器推送通知）
app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const { transport } = sessions[sessionId];
    await transport.handleRequest(req, res);
});

// DELETE /mcp — 终止会话
app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const { transport } = sessions[sessionId];
    await transport.handleRequest(req, res);
});

// 启动服务器
app.listen(MCP_PORT, MCP_HOST, () => {
    console.log(`MCP HTTP server listening on ${MCP_HOST}:${MCP_PORT}`);
});

// 优雅关闭
process.on('SIGINT', async () => {
    for (const sid in sessions) {
        await sessions[sid].transport.close();
        delete sessions[sid];
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    for (const sid in sessions) {
        await sessions[sid].transport.close();
        delete sessions[sid];
    }
    process.exit(0);
});
```

### 4. 配置变更 (`config.ts`)

新增 HTTP 相关的环境变量解析：

| 环境变量 | 用途 | 默认值 |
|---------|------|--------|
| `MCP_HTTP_PORT` | HTTP 服务器监听端口 | `3000` |
| `MCP_HTTP_HOST` | HTTP 服务器绑定地址 | `0.0.0.0` |
| `MCP_AUTH_TOKEN` | Bearer Token 认证令牌 | 无（未设置时跳过认证） |

这些变量与现有环境变量模式一致，支持 `~/.context/.env` 文件 + 进程环境变量覆盖。

### 5. `package.json` 变更

```json
{
    "bin": {
        "claude-context-mcp": "dist/index.js",
        "claude-context-mcp-http": "dist/http.js"
    },
    "dependencies": {
        "@zilliz/claude-context-core": "workspace:*",
        "@modelcontextprotocol/sdk": "^1.12.1",
        "express": "^4.21.0",
        "zod": "^3.25.55"
    },
    "devDependencies": {
        "@types/express": "^4.17.21",
        "@types/node": "^20.0.0",
        "tsx": "^4.19.4",
        "typescript": "^5.0.0"
    }
}
```

新增 npm scripts：

```json
{
    "scripts": {
        "start:http": "tsx src/http.ts",
        "dev:http": "tsx --watch src/http.ts"
    }
}
```

### 6. 错误处理

| 场景 | 处理方式 |
|------|---------|
| HTTP 请求处理异常 | 返回 HTTP 500 + JSON-RPC `InternalError` (-32603) |
| 无效/缺失 session ID | 返回 HTTP 400 + JSON-RPC `InvalidRequest` (-32000) |
| 认证失败（Token 不匹配） | 返回 HTTP 401 + JSON-RPC `Unauthorized` (-32000) |
| 服务器启动失败 | 打印错误到 stderr，exit(1) |
| 会话关闭 | 自动清理 transport 和 session 记录 |

### 7. 安全性

- **Token 认证**：通过 `MCP_AUTH_TOKEN` 环境变量配置 Bearer Token
- **无认证模式**：未设置 `MCP_AUTH_TOKEN` 时跳过认证（适用于本地开发或受信任网络）
- **生产建议**：配合反向代理（如 nginx/Caddy）使用 HTTPS，避免明文传输

### 8. 会话管理

- **有状态模式**：使用 `sessions` Map 管理活跃会话
- **每会话独立实例**：每个 HTTP 会话创建独立的 `McpServerInstance`（包括独立的 Server、SyncManager 等）
- **共享底层资源**：所有会话共享同一个 Milvus 向量数据库连接和文件系统状态（snapshot、lock）
- **跨进程锁**：`SyncManager` 的全局锁机制在 HTTP 模式下继续正常工作
- **会话清理**：transport 关闭时自动清理 session 记录

### 9. 后台同步

HTTP 模式下后台同步行为与 stdio 模式完全一致：
- 定期轮询（默认 5 分钟，可通过 `CLAUDE_CONTEXT_SYNC_INTERVAL_MS` 配置）
- 触发文件监听（`~/.context/.sync-trigger`）
- 跨进程锁防止并发同步

HTTP 服务器通常是长期运行的，后台同步可以持续工作，这是一个优势。

### 10. 客户端配置示例

HTTP 模式的客户端配置：

```json
{
    "mcpServers": {
        "claude-context": {
            "url": "http://localhost:3000/mcp"
        }
    }
}
```

带认证的配置（如果服务器设置了 `MCP_AUTH_TOKEN`）：

```json
{
    "mcpServers": {
        "claude-context": {
            "url": "http://localhost:3000/mcp",
            "headers": {
                "Authorization": "Bearer your-secret-token"
            }
        }
    }
}
```

## 测试计划

### 现有测试

不受影响，现有 stdio 相关测试保持不变。

### 新增测试

1. **HTTP 服务器启动/关闭测试**
   - 服务器正常启动并监听指定端口
   - SIGINT/SIGTERM 触发优雅关闭

2. **认证测试**
   - 有效 Token 请求通过
   - 无效 Token 返回 401
   - 未配置 Token 时跳过认证

3. **会话管理测试**
   - 新会话创建（initialize 请求）
   - 会话复用（带 session ID 的后续请求）
   - 会话终止（DELETE 请求）
   - 无效 session ID 返回 400

4. **MCP 工具调用测试（通过 HTTP）**
   - 基本的 `get_indexing_status` 工具调用
   - 工具列表获取

## 依赖

- `express` ^4.21.0 — HTTP 服务器框架
- `@types/express` ^4.17.21 — TypeScript 类型定义
- `@modelcontextprotocol/sdk` ^1.12.1 — 已有依赖，包含 `StreamableHTTPServerTransport`

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 工厂函数提取可能引入回归 bug | 现有测试覆盖 + 手动验证 stdio 模式 |
| Express 新增依赖增加包体积 | Express 是成熟稳定的框架，体积可控 |
| 多会话并发导致资源竞争 | 已有的跨进程锁机制可覆盖 |
| SDK 版本兼容性（StreamableHTTPServerTransport） | 确认 v1.12.1 已包含此传输 |
