#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Only run main when this file is the entry point (not when imported for testing)
// Resolve symlinks (npm/pnpm link creates shim scripts that differ from the actual file path)
const isMain = (() => {
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();
if (isMain) {
    main().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
