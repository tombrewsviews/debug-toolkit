/**
 * utils.ts — Shared utilities for memory and pack modules.
 */
export declare function memoryPath(cwd: string): string;
export declare function atomicWrite(filePath: string, data: string): void;
export declare function walPath(cwd: string): string;
export declare function archiveDirPath(cwd: string): string;
export declare function tokenize(text: string): string[];
export declare function screenshotDir(cwd: string): string;
export declare function saveScreenshot(cwd: string, sessionId: string, phase: string, base64Data: string): string;
