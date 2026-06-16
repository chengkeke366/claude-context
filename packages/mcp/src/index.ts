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
