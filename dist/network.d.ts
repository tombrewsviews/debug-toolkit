export interface DevServerInfo {
    port: number;
    pid: number;
    process: string;
}
export interface Connection {
    remoteAddr: string;
    remotePort: number;
    state: string;
    service?: string;
}
export interface NetworkTopology {
    devServer: DevServerInfo | null;
    inbound: Connection[];
    outbound: Connection[];
    missing?: string[];
}
export declare function inferService(port: number): string | undefined;
export declare function parseLsofListeners(output: string): DevServerInfo[];
export declare function parseLsofConnections(output: string, serverPid: number): {
    inbound: Connection[];
    outbound: Connection[];
};
export declare const DEV_PORTS: number[];
export declare function detectDevServers(): DevServerInfo[];
export declare function getNetworkTopology(server: DevServerInfo, cwd: string): Promise<NetworkTopology>;
export declare function detectMissingConnections(outbound: Connection[], cwd: string): Promise<string[]>;
export declare function getCachedTopology(cwd: string): Promise<NetworkTopology | null>;
export declare function clearTopologyCache(): void;
