import { type ChildProcess } from "node:child_process";
import { type Capture, type DebugSession } from "./session.js";
export interface BuildError {
    tool: "vite" | "tsc" | "webpack" | "eslint" | "postcss" | "unknown";
    file: string | null;
    line: number | null;
    column: number | null;
    code: string | null;
    message: string;
    raw: string;
}
export declare function parseBuildError(text: string): BuildError | null;
declare class RingBuffer<T> {
    private buf;
    private head;
    private count;
    private cap;
    constructor(capacity: number);
    push(item: T): void;
    drain(): T[];
    /** Read last N items without removing them from the buffer */
    peek(n?: number): T[];
    get length(): number;
}
export declare const terminalBuffer: RingBuffer<Capture>;
export declare const browserBuffer: RingBuffer<Capture>;
export declare const buildBuffer: RingBuffer<BuildError>;
/**
 * Peek at recent terminal + browser + build output WITHOUT draining.
 * Used by debug_investigate to auto-include runtime context.
 */
export declare function peekRecentOutput(opts?: {
    terminalLines?: number;
    browserLines?: number;
    buildErrors?: number;
}): {
    terminal: Capture[];
    browser: Capture[];
    buildErrors: BuildError[];
    counts: {
        terminal: number;
        browser: number;
        buildErrors: number;
    };
};
/**
 * Drain all accumulated build errors from the buffer.
 */
export declare function drainBuildErrors(): BuildError[];
export declare function pipeProcess(child: ChildProcess): void;
export declare function runAndCapture(command: string, timeoutMs?: number): Promise<Capture[]>;
export declare function onBrowserEvent(event: {
    type: string;
    data: unknown;
    ts: number;
}): void;
export declare function drainCaptures(cwd: string, session: DebugSession): Capture[];
/**
 * Discover Tauri log files for a project.
 * Searches platform-specific log directories based on the bundle identifier.
 */
export declare function discoverTauriLogs(cwd: string): {
    logDir: string | null;
    logFiles: string[];
    identifier: string | null;
};
/**
 * Read recent lines from Tauri log files.
 * Returns captures from the most recent log file.
 */
export declare function readTauriLogs(cwd: string, tailLines?: number): Capture[];
export declare function getRecentCaptures(session: DebugSession, opts?: {
    limit?: number;
    source?: string;
    markerOnly?: boolean;
}): {
    captures: Capture[];
    total: number;
    showing: number;
};
export {};
