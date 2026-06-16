# MCP HTTP Server 部署指南

本文档描述从源码拉取到 HTTP MCP Server 启动、客户端连接的完整部署流程。

## 前置条件

| 依赖    | 版本要求   | 说明                                        |
| ------- | ---------- | ------------------------------------------- |
| Node.js | >= 20.0.0  | 推荐使用 nvm 管理                           |
| pnpm    | >= 9.0.0   | 项目包管理器                                |
| Git     | >= 2.x     | 代码版本管理                                |
| Milvus  | Standalone | 向量数据库，本地 Docker 部署或 Zilliz Cloud |

### Node.js 与 pnpm 版本兼容性

项目 `package.json` 的 `engines` 字段声明了最低版本要求：

```json
{
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

**pnpm v10+** 要求 Node.js >= 22.13。如果你的 Node.js 版本低于 22.13（例如 v22.6.0），需要安装 pnpm v9：

```bash
# 安装 pnpm v9（兼容 Node.js >= 18.12）
npm install -g pnpm@9

# 或安装 pnpm v10（需要 Node.js >= 22.13）
npm install -g pnpm@10
```

使用 nvm 管理 Node.js 版本时，可以灵活切换：

```bash
# 方案 A：低版本 Node.js + pnpm v9
nvm install 22.6.0
npm install -g pnpm@9

# 方案 B：高版本 Node.js + pnpm v10
nvm install 22.13
npm install -g pnpm@10
```

验证版本是否匹配：

```bash
node --version   # 需 >= 20.0.0
pnpm --version   # 需 >= 9.0.0
```

## 1. 拉取代码

```bash
git clone git@github.com:chengkeke366/claude-context.git
cd claude-context
```


## 2. 安装依赖

```bash
pnpm install
```

## 3. 编译构建

在项目根目录下执行，通过 pnpm workspace filter 构建 mcp 包及其依赖（`@zilliz/claude-context-core`）：

```bash
pnpm build:mcp
```

> 也可以使用 `pnpm build` 构建所有包（包括 core、mcp、vscode、examples）。

构建产物输出到 `packages/mcp/dist/` 目录。构建完成后需要确保入口文件具有可执行权限：

```bash
chmod +x packages/mcp/dist/http.js packages/mcp/dist/index.js
```

> **注意**：每次执行 `pnpm build:mcp` 后都需要重新设置可执行权限，因为构建脚本中的 `rimraf dist` 会清除旧文件。

## 4. 全局注册命令

通过 `npm link` 将 `claude-context-mcp` 和 `claude-context-mcp-http` 两个命令注册为全局可用：

```bash
# npm link 需要在定义了 bin 字段的包目录下执行
cd packages/mcp
npm link
cd ../..  # 返回项目根目录
```

验证注册是否成功：

```bash
which claude-context-mcp
# 输出示例：~/.nvm/versions/node/v22.6.0/bin/claude-context-mcp

which claude-context-mcp-http
# 输出示例：~/.nvm/versions/node/v22.6.0/bin/claude-context-mcp-http
```

两个命令分别对应：

| 命令                      | 入口文件        | 传输模式                    |
| ------------------------- | --------------- | --------------------------- |
| `claude-context-mcp`      | `dist/index.js` | stdio（进程间通信）         |
| `claude-context-mcp-http` | `dist/http.js`  | Streamable HTTP（网络请求） |

## 5. 启动 HTTP MCP Server

### 5.1 环境变量配置

启动前需要设置以下环境变量：

#### 必填环境变量

| 变量                 | 说明                            | 示例值                   |
| -------------------- | ------------------------------- | ------------------------ |
| `EMBEDDING_PROVIDER` | Embedding 服务商                | `OpenAI`                 |
| `EMBEDDING_MODEL`    | Embedding 模型名称              | `text-embedding-v4`      |
| `OPENAI_API_KEY`     | OpenAI（或兼容接口）API Key     | `sk-xxx`                 |
| `MILVUS_ADDRESS`     | Milvus 服务地址                 | `http://localhost:19530` |
| `MILVUS_TOKEN`       | Milvus 认证 Token（本地可为空） | `""`                     |

#### HTTP 传输专用环境变量

| 变量             | 说明                      | 默认值             |
| ---------------- | ------------------------- | ------------------ |
| `MCP_HTTP_PORT`  | HTTP 监听端口             | `3000`             |
| `MCP_HTTP_HOST`  | HTTP 绑定地址             | `0.0.0.0`          |
| `MCP_AUTH_TOKEN` | Bearer Token 认证（可选） | 不设置则不启用认证 |

#### 可选环境变量

| 变量                   | 说明                       | 默认值                      |
| ---------------------- | -------------------------- | --------------------------- |
| `OPENAI_BASE_URL`      | OpenAI 兼容接口的 Base URL | `https://api.openai.com/v1` |
| `EMBEDDING_BATCH_SIZE` | Embedding 批量处理大小     | `100`                       |

### 5.2 启动命令

**方式一：直接运行（前台）**

```bash
OPENAI_API_KEY="sk-your-api-key" \
OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1" \
EMBEDDING_PROVIDER="OpenAI" \
EMBEDDING_MODEL="text-embedding-v4" \
EMBEDDING_BATCH_SIZE="10" \
MILVUS_ADDRESS="http://localhost:19530" \
MILVUS_TOKEN="" \
MCP_HTTP_PORT=3000 \
MCP_HTTP_HOST=0.0.0.0 \
MCP_AUTH_TOKEN="your-secret-token" \
  claude-context-mcp-http
```

**方式二：后台运行**

```bash
OPENAI_API_KEY="sk-your-api-key" \
OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1" \
EMBEDDING_PROVIDER="OpenAI" \
EMBEDDING_MODEL="text-embedding-v4" \
EMBEDDING_BATCH_SIZE="10" \
MILVUS_ADDRESS="http://localhost:19530" \
MILVUS_TOKEN="" \
MCP_HTTP_PORT=3000 \
MCP_HTTP_HOST=0.0.0.0 \
MCP_AUTH_TOKEN="your-secret-token" \
  nohup claude-context-mcp-http > /tmp/mcp-http.log 2>&1 &
```

**方式三：使用全局配置文件**

创建 `~/.context/.env` 文件，避免每次在命令行中传入环境变量：

```bash
mkdir -p ~/.context
cat > ~/.context/.env << 'EOF'
EMBEDDING_PROVIDER=OpenAI
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_BATCH_SIZE=10
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MILVUS_ADDRESS=http://localhost:19530
MILVUS_TOKEN=
MCP_HTTP_PORT=3000
MCP_HTTP_HOST=0.0.0.0
MCP_AUTH_TOKEN=your-secret-token
EOF
```

然后直接启动：

```bash
claude-context-mcp-http
```

> 进程环境变量优先级高于 `~/.context/.env` 文件。

### 5.3 启动成功输出

```
[MCP] Configuration Summary:
[MCP]   Embedding Provider: OpenAI
[MCP]   Embedding Model: text-embedding-v4
[MCP]   Milvus Address: http://localhost:19530
[MCP]   OpenAI API Key: ✅ Configured
[MCP]   HTTP Port: 3000
[MCP]   HTTP Host: 0.0.0.0
[MCP]   Auth Token: ✅ Configured
MCP Streamable HTTP server listening on 0.0.0.0:3000
Authentication: enabled (Bearer token)
```

### 5.4 验证服务是否可用

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "id": 1,
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "1.0" }
    }
  }'
```

预期返回：

```
event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"Context MCP Server","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

> 如果未设置 `MCP_AUTH_TOKEN`，可省略 `Authorization` 请求头。

### 5.5 停止服务

- **前台运行**：按 `Ctrl+C` 触发优雅关闭
- **后台运行**：

```bash
# 查找进程
ps aux | grep claude-context-mcp-http

# 发送 SIGTERM 信号
kill <PID>
```

## 6. MCP 客户端连接配置

### 6.1 Cursor

在 `~/.cursor/mcp.json`（全局）或项目目录 `.cursor/mcp.json`（项目级）中添加：

**带认证：**

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

**不带认证（本地开发）：**

```json
{
    "mcpServers": {
        "claude-context": {
            "url": "http://localhost:3000/mcp"
        }
    }
}
```

> **注意**：Cursor 需要支持 Streamable HTTP 传输协议。如果 Cursor 版本不支持 `url` 配置项，请升级 Cursor 或改用 stdio 模式。

### 6.2 Claude Code

```bash
claude mcp add claude-context --transport http \
  -e MCP_AUTH_TOKEN=your-secret-token \
  -- http://localhost:3000/mcp
```

### 6.3 其他支持 HTTP 传输的 MCP 客户端

通用配置格式：

```json
{
    "mcpServers": {
        "claude-context": {
            "url": "http://<host>:<port>/mcp",
            "headers": {
                "Authorization": "Bearer <token>"
            }
        }
    }
}
```

### 6.4 远程连接

如果 HTTP Server 部署在远程机器上：

1. 确保服务器防火墙开放对应端口（默认 3000）
2. 生产环境建议配置反向代理（nginx/Caddy）启用 HTTPS
3. 客户端 URL 替换为实际地址：`https://your-domain.com/mcp`

**nginx 反向代理示例：**

```nginx
server {
    listen 443 ssl;
    server_name mcp.your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

## 7. HTTP API 端点

| 方法          | 路径                   | 说明                                                                          |
| ------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `POST /mcp`   | 接收 MCP JSON-RPC 请求 | 首次 `initialize` 请求无需 session ID，后续请求需携带 `mcp-session-id` 请求头 |
| `GET /mcp`    | SSE 事件流             | 服务端推送通知，需携带 `mcp-session-id` 请求头                                |
| `DELETE /mcp` | 终止会话               | 清理指定 session 的资源，需携带 `mcp-session-id` 请求头                       |

## 8. 代码更新后重新部署

当拉取了新代码后，在项目根目录下重新构建并设置权限：

```bash
pnpm build:mcp
chmod +x packages/mcp/dist/http.js packages/mcp/dist/index.js
```

全局命令无需重新 link（`npm link` 创建的是符号链接，指向 dist 目录）。

重启 HTTP Server 使新版本生效：

```bash
# 停止旧进程
kill $(pgrep -f claude-context-mcp-http)

# 重新启动
claude-context-mcp-http
```

## 附录：stdio 模式（对比参考）

如果客户端不支持 HTTP 传输，仍可使用 stdio 模式。无需启动 HTTP Server，客户端直接通过进程通信连接：

```json
{
    "mcpServers": {
        "claude-context": {
            "command": "claude-context-mcp",
            "env": {
                "EMBEDDING_PROVIDER": "OpenAI",
                "EMBEDDING_MODEL": "text-embedding-v4",
                "OPENAI_API_KEY": "sk-your-api-key",
                "MILVUS_ADDRESS": "http://localhost:19530",
                "MILVUS_TOKEN": ""
            }
        }
    }
}
```

stdio 模式与 HTTP 模式的区别：

| 特性       | stdio 模式         | HTTP 模式      |
| ---------- | ------------------ | -------------- |
| 传输方式   | 进程标准输入/输出  | HTTP 请求      |
| 生命周期   | 随客户端启停       | 独立长期运行   |
| 多客户端   | 不支持（一对一）   | 支持（多会话） |
| 远程访问   | 不支持             | 支持           |
| 客户端配置 | `command` + `args` | `url`          |
