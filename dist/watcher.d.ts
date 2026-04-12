/**
 * watcher.ts — Live loop detection for serve mode.
 *
 * Monitors .debug/live-context.json for error patterns that indicate
 * an agent (any agent — Claude Code, Lovable, Bolt, Replit, or a human)
 * is going in circles. When detected, prints actionable warnings to
 * the terminal and optionally sends a desktop notification.
 *
 * This is the bridge between stackpack-debug and closed agent systems.
 * The user can't inject tools into Lovable's sandbox, but they CAN
 * run `spdg serve` while the closed agent works. The watcher sees
 * the same errors the agent sees and detects loops the agent can't.
 */
/**
 * Start the loop watcher. Polls live-context.json and prints alerts.
 * Returns a stop function.
 */
export declare function startLoopWatcher(cwd: string): {
    stop: () => void;
};
