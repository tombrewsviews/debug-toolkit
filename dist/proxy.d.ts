export interface ProxyOptions {
    targetPort: number;
    listenPort: number;
}
export declare function startProxy(opts: ProxyOptions): {
    close: () => void;
};
/**
 * Detect the dev server port by watching child process output.
 * Returns a promise that resolves with the port or rejects after timeout.
 */
export declare function detectPort(stdout: NodeJS.ReadableStream, timeoutMs?: number): Promise<number>;
