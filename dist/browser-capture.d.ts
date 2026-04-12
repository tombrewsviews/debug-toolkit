/**
 * browser-capture.ts — Generate browser console scripts for closed agent platforms.
 *
 * Each platform has a different DOM structure for the preview iframe.
 * This module generates the correct capture script for each platform,
 * which the user pastes into their browser console.
 *
 * The script:
 * 1. Finds the preview iframe (platform-specific selector)
 * 2. Injects error/network listeners into the iframe's content window
 * 3. Sends captured events to a local WebSocket server (localhost only)
 * 4. Re-injects on iframe navigation (SPA route changes, HMR reloads)
 */
export type AgentPlatform = "lovable" | "bolt" | "replit" | "base44" | "custom";
/**
 * Detect which platform the user is on based on URL.
 */
export declare function detectPlatform(url: string): AgentPlatform | null;
/**
 * Generate the browser console script for a given platform.
 * The script is a self-contained IIFE that the user pastes into DevTools console.
 */
export declare function generateCaptureScript(platform: AgentPlatform, opts?: {
    wsPort?: number;
}): string;
/**
 * Get the list of supported platforms for the setup wizard.
 */
export declare function listPlatforms(): Array<{
    id: AgentPlatform;
    name: string;
    description: string;
}>;
