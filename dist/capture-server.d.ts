/**
 * capture-server.ts — Local WebSocket server for browser event capture.
 *
 * Receives events from the browser capture script (console paste)
 * and feeds them into the same ring buffers that serve mode uses.
 * This makes browser-captured errors visible to the watcher,
 * loop detection, and the MCP status resource.
 */
import { type Server } from "node:http";
export interface CaptureEvent {
    type: "error" | "rejection" | "console" | "network" | "terminal" | "agent_chat" | "agent_message" | "editor_change";
    ts: number;
    source: string;
    message?: string;
    args?: string;
    stack?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
    reason?: string;
    method?: string;
    url?: string;
    status?: number;
    error?: string;
    level?: string;
    text?: string;
    msgIndex?: number;
    streaming?: boolean;
    length?: number;
    preview?: string;
}
interface CaptureServerOptions {
    port: number;
    cwd: string;
    platform?: string;
    onEvent?: (event: CaptureEvent) => void;
}
/**
 * Start the local capture server.
 * Returns handles for the HTTP server and a stop function.
 */
export declare function startCaptureServer(opts: CaptureServerOptions): {
    server: Server;
    stop: () => void;
    port: number;
};
export {};
