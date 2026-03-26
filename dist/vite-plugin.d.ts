/**
 * Vite plugin for debug-toolkit.
 * Injects console/error/network capture directly into HTML served by Vite.
 *
 * This is critical for Tauri/Electron apps where the webview loads from
 * the Vite dev server directly (not through the debug-toolkit proxy).
 *
 * Usage in vite.config.ts:
 *   import debugToolkit from 'debug-toolkit/vite-plugin';
 *   export default defineConfig({ plugins: [debugToolkit()] });
 *
 * Or auto-configured by `npx debug-toolkit init` for Tauri projects.
 */
import type { Plugin } from "vite";
export interface DebugToolkitPluginOptions {
    /** Port the debug-toolkit proxy WebSocket listens on. Default: auto-detect from env or 2420 */
    wsPort?: number;
    /** Disable in production builds. Default: true (only active in dev) */
    devOnly?: boolean;
}
export default function debugToolkitPlugin(opts?: DebugToolkitPluginOptions): Plugin;
