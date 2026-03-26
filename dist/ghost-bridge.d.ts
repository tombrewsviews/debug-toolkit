/**
 * ghost-bridge.ts — MCP client bridge to Ghost OS.
 *
 * Connects to Ghost OS as a child process via MCP stdio transport.
 * Provides typed wrappers for screenshot, DOM read, element inspection.
 * Gracefully degrades when Ghost OS is not installed.
 */
export declare function connectToGhostOs(): Promise<boolean>;
export declare function disconnectGhostOs(): Promise<void>;
export declare function isGhostConnected(): boolean;
export declare function resetConnectionState(): void;
export interface ScreenshotResult {
    image: string;
    windowFrame?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
export declare function takeScreenshot(app?: string): Promise<ScreenshotResult | null>;
export interface ScreenElement {
    role: string;
    name: string;
    position?: {
        x: number;
        y: number;
    };
    actionable?: boolean;
}
export declare function readScreen(app?: string, query?: string): Promise<{
    text: string;
    elements: ScreenElement[];
} | null>;
export declare function inspectElement(query: string, app?: string): Promise<{
    role: string;
    title: string;
    position: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    visible: boolean;
} | null>;
export declare function findElements(query: string, role?: string, app?: string): Promise<ScreenElement[]>;
export declare function annotateScreen(app?: string): Promise<{
    image: string;
    labels: Array<{
        id: number;
        role: string;
        name: string;
        x: number;
        y: number;
    }>;
} | null>;
