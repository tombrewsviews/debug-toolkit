/**
 * ghost-bridge.ts — MCP client bridge to Ghost OS.
 *
 * Connects to Ghost OS as a child process via MCP stdio transport.
 * Provides typed wrappers for screenshot, DOM read, element inspection.
 * Gracefully degrades when Ghost OS is not installed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { getPackageVersion } from "./utils.js";
let ghostClient = null;
let ghostTransport = null;
let connectionAttempted = false;
// Diagnostic state for surfacing connection issues
let lastError = null;
let lastSuccessTs = null;
let resolvedBinaryPath = null;
export function getVisualDiagnostic() {
    const ago = lastSuccessTs
        ? `${Math.round((Date.now() - lastSuccessTs) / 1000)}s ago`
        : null;
    return {
        connected: ghostClient !== null,
        binaryFound: resolvedBinaryPath !== null,
        binaryPath: resolvedBinaryPath,
        lastError,
        lastSuccessTs,
        lastSuccessAgo: ago,
    };
}
function findGhostBinary() {
    try {
        const path = execSync("which ghost 2>/dev/null || which ghost-os 2>/dev/null", {
            stdio: "pipe",
            timeout: 3000,
        }).toString().trim();
        return path || null;
    }
    catch {
        return null;
    }
}
export async function connectToGhostOs() {
    if (ghostClient)
        return true;
    if (connectionAttempted)
        return false; // Don't retry failed connections repeatedly
    connectionAttempted = true;
    const binary = findGhostBinary();
    resolvedBinaryPath = binary;
    if (!binary) {
        lastError = "Ghost OS binary not found (checked 'ghost' and 'ghost-os' in PATH)";
        return false;
    }
    try {
        ghostTransport = new StdioClientTransport({
            command: binary,
            args: ["mcp"], // Ghost OS MCP mode
        });
        ghostClient = new Client({
            name: "stackpack-debug",
            version: getPackageVersion(),
        });
        await ghostClient.connect(ghostTransport);
        // Verify connection by listing tools
        const tools = await ghostClient.listTools();
        if (!tools.tools.some((t) => t.name === "ghost_screenshot")) {
            lastError = "Ghost OS connected but ghost_screenshot tool not found — may be an incompatible version";
            await disconnectGhostOs();
            return false;
        }
        lastError = null;
        return true;
    }
    catch (e) {
        lastError = `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
        ghostClient = null;
        ghostTransport = null;
        return false;
    }
}
export async function disconnectGhostOs() {
    try {
        if (ghostClient)
            await ghostClient.close();
    }
    catch { /* ignore */ }
    ghostClient = null;
    ghostTransport = null;
}
export function isGhostConnected() {
    return ghostClient !== null;
}
export function resetConnectionState() {
    connectionAttempted = false;
}
async function callTool(name, args = {}) {
    if (!ghostClient)
        return null;
    try {
        const result = await ghostClient.callTool({ name, arguments: args });
        lastSuccessTs = Date.now();
        lastError = null;
        // MCP tool results have a content array
        if (result.content && Array.isArray(result.content) && result.content.length > 0) {
            const first = result.content[0];
            if (first.type === "text") {
                try {
                    return JSON.parse(first.text);
                }
                catch {
                    return first.text;
                }
            }
            if (first.type === "image") {
                return { image: first.data, mimeType: first.mimeType };
            }
            return first;
        }
        return result;
    }
    catch (e) {
        lastError = `${name} failed: ${e instanceof Error ? e.message : String(e)}`;
        return null;
    }
}
export async function takeScreenshot(app) {
    const result = await callTool("ghost_screenshot", app ? { app } : {});
    if (!result)
        return null;
    // ghost_screenshot returns an image content block
    if (result.image)
        return { image: result.image };
    return null;
}
export async function readScreen(app, query) {
    const args = {};
    if (app)
        args.app = app;
    if (query)
        args.query = query;
    const result = await callTool("ghost_read", args);
    if (!result)
        return null;
    if (typeof result === "string")
        return { text: result, elements: [] };
    return { text: result.text ?? String(result), elements: result.elements ?? [] };
}
export async function inspectElement(query, app) {
    const args = { query };
    if (app)
        args.app = app;
    const result = await callTool("ghost_inspect", args);
    if (!result || typeof result !== "object")
        return null;
    return {
        role: result.role ?? "unknown",
        title: result.title ?? "",
        position: result.position ?? { x: 0, y: 0, width: 0, height: 0 },
        visible: result.visible ?? true,
    };
}
export async function findElements(query, role, app) {
    const args = { query };
    if (role)
        args.role = role;
    if (app)
        args.app = app;
    const result = await callTool("ghost_find", args);
    if (!result)
        return [];
    if (Array.isArray(result))
        return result;
    if (typeof result === "object" && result !== null && "elements" in result)
        return result.elements;
    return [];
}
export async function annotateScreen(app) {
    const result = await callTool("ghost_annotate", app ? { app } : {});
    if (!result)
        return null;
    return {
        image: result.image ?? "",
        labels: result.labels ?? result.index ?? [],
    };
}
//# sourceMappingURL=ghost-bridge.js.map