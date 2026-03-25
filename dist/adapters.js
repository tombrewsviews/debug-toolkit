/**
 * adapters.ts — MCP tool discovery for visual integrations.
 *
 * Detects available tools from Ghost OS and Claude Preview at runtime.
 * All visual features gracefully degrade when no tools are available.
 */
const GHOST_TOOLS = {
    screenshot: "ghost_screenshot",
    dom: "ghost_read",
    inspect: "ghost_inspect",
};
const PREVIEW_TOOLS = {
    screenshot: "preview_screenshot",
    dom: "preview_snapshot",
    inspect: "preview_inspect",
};
export function detectVisualTools(availableTools) {
    const set = new Set(availableTools);
    const hasGhostScreenshot = set.has(GHOST_TOOLS.screenshot);
    const hasGhostDom = set.has(GHOST_TOOLS.dom);
    const hasGhostInspect = set.has(GHOST_TOOLS.inspect);
    const hasPreviewScreenshot = set.has(PREVIEW_TOOLS.screenshot);
    const hasPreviewDom = set.has(PREVIEW_TOOLS.dom);
    const hasPreviewInspect = set.has(PREVIEW_TOOLS.inspect);
    return {
        canScreenshot: hasGhostScreenshot || hasPreviewScreenshot,
        canReadDom: hasGhostDom || hasPreviewDom,
        canInspect: hasGhostInspect || hasPreviewInspect,
        screenshotTool: hasGhostScreenshot ? GHOST_TOOLS.screenshot
            : hasPreviewScreenshot ? PREVIEW_TOOLS.screenshot : null,
        domTool: hasGhostDom ? GHOST_TOOLS.dom
            : hasPreviewDom ? PREVIEW_TOOLS.dom : null,
        inspectTool: hasGhostInspect ? GHOST_TOOLS.inspect
            : hasPreviewInspect ? PREVIEW_TOOLS.inspect : null,
        availableTools: availableTools.filter((t) => Object.values(GHOST_TOOLS).includes(t) ||
            Object.values(PREVIEW_TOOLS).includes(t)),
    };
}
export function formatCapabilitiesSummary(caps) {
    if (!caps.canScreenshot && !caps.canReadDom) {
        return "No visual tools detected. Screenshots and DOM capture unavailable.";
    }
    const parts = [];
    if (caps.screenshotTool)
        parts.push(`screenshot: ${caps.screenshotTool}`);
    if (caps.domTool)
        parts.push(`DOM: ${caps.domTool}`);
    if (caps.inspectTool)
        parts.push(`inspect: ${caps.inspectTool}`);
    return `Visual tools: ${parts.join(", ")}`;
}
//# sourceMappingURL=adapters.js.map