/**
 * Vite plugin for stackpack-debug.
 * Injects console/error/network capture directly into HTML served by Vite.
 *
 * This is critical for Tauri/Electron apps where the webview loads from
 * the Vite dev server directly (not through the stackpack-debug proxy).
 *
 * Usage in vite.config.ts:
 *   import debugToolkit from 'stackpack-debug/vite-plugin';
 *   export default defineConfig({ plugins: [debugToolkit()] });
 *
 * Or auto-configured by `npx stackpack-debug init` for Tauri projects.
 */
import type { Plugin } from "vite";
export interface DebugToolkitPluginOptions {
    /** Port the stackpack-debug proxy WebSocket listens on. Default: auto-detect from env or 2420 */
    wsPort?: number;
    /** Disable in production builds. Default: true (only active in dev) */
    devOnly?: boolean;
}
export default function debugToolkitPlugin(opts?: DebugToolkitPluginOptions): Plugin;
