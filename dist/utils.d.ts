/**
 * utils.ts — Shared utilities for memory and pack modules.
 */
export declare function getPackageVersion(): string;
export interface UpdateCheck {
    current: string;
    latest: string;
    updateAvailable: boolean;
    updateCommand: string;
}
export declare function checkForUpdate(): UpdateCheck;
export declare function runSelfUpdate(): {
    success: boolean;
    from: string;
    to: string;
    message: string;
};
/**
 * Runs a background self-upgrade on startup. Non-blocking — spawns the upgrade
 * in a child process and calls `onResult` when it completes.
 *
 * Strategy:
 * 1. Check npm registry for latest version (fast, ~1-2s)
 * 2. If a newer version exists, upgrade in-place (global or npx cache)
 * 3. Notify the caller with the result so it can print a message
 *
 * The child process is unref'd so it won't keep the parent alive if the user
 * exits before the upgrade finishes.
 */
export declare function backgroundSelfUpgrade(onResult: (result: {
    upgraded: boolean;
    from: string;
    to: string;
    message: string;
}) => void): void;
export declare function memoryPath(cwd: string): string;
export declare function atomicWrite(filePath: string, data: string): void;
export declare function walPath(cwd: string): string;
export declare function archiveDirPath(cwd: string): string;
export declare function tokenize(text: string): string[];
export declare function screenshotDir(cwd: string): string;
export declare function saveScreenshot(cwd: string, sessionId: string, phase: string, base64Data: string): string;
