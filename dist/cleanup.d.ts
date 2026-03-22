import { type DebugSession } from "./session.js";
export interface CleanupResult {
    cleaned: number;
    verified: boolean;
    errors: string[];
    filesProcessed: string[];
}
export declare function cleanupSession(cwd: string, session: DebugSession): CleanupResult;
/**
 * Emergency cleanup from manifest-less scan of session files.
 */
export declare function cleanupFromManifest(cwd: string): CleanupResult;
