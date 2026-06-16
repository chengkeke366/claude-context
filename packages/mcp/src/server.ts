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