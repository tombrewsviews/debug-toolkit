/**
 * Live Activity Feed — shows MCP tool activity in the serve terminal.
 *
 * MCP and serve run in separate processes. They communicate via
 * `.debug/activity.jsonl` — MCP appends events, serve tails and renders.
 */
export interface ActivityEvent {
    tool: string;
    ts: number;
    summary: string;
    metrics?: Record<string, string | number | undefined>;
}
export declare function enableActivityWriter(cwd: string): void;
export declare function logActivity(event: ActivityEvent): void;
export declare function startActivityFeed(cwd: string): {
    stop: () => void;
};
