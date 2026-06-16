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
        const body = await res.json() as { error: { code: number; message: string } };
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
