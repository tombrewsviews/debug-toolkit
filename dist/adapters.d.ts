/**
 * adapters.ts — MCP tool discovery for visual integrations.
 *
 * Detects available tools from Ghost OS and Claude Preview at runtime.
 * All visual features gracefully degrade when no tools are available.
 */
export interface VisualCapabilities {
    canScreenshot: boolean;
    canReadDom: boolean;
    canInspect: boolean;
    screenshotTool: "ghost_screenshot" | "preview_screenshot" | null;
    domTool: "ghost_read" | "preview_snapshot" | null;
    inspectTool: "ghost_inspect" | "preview_inspect" | null;
    availableTools: string[];
}
export declare function detectVisualTools(availableTools: string[]): VisualCapabilities;
export declare function formatCapabilitiesSummary(caps: VisualCapabilities): string;
