/**
 * mcp.ts — MCP server with 9 tools + 1 resource.
 *
 * Design principles:
 *   1. One tool = one complete outcome. No chatty multi-step protocols.
 *   2. Preprocess, don't dump. Summarize and highlight, never return raw arrays.
 *   3. Every response tells the agent what to do next.
 *   4. Context window space is precious — keep responses compact.
 *   5. Memory: save diagnoses, recall past fixes for similar errors.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function setCwd(dir: string): void;
export declare function createMcpServer(): McpServer;
export declare function startMcpServer(): Promise<void>;
