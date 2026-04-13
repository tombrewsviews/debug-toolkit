import { execSync } from "node:child_process";
import { platform } from "node:os";

// NOTE: readConfigState is imported lazily inside detectMissingConnections()
// to avoid a circular dependency: capture.ts → network.ts → capture.ts

// --- Types ---

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

// --- Well-known service ports ---

const SERVICE_MAP: Record<number, string> = {
  11434: "ollama",
  5432: "postgres",
  3306: "mysql",
  6379: "redis",
  27017: "mongodb",
  80: "http",
  443: "https",
};

export function inferService(port: number): string | undefined {
  return SERVICE_MAP[port];
}

// --- lsof parsing ---

export function parseLsofListeners(output: string): DevServerInfo[] {
  if (!output.trim()) return [];

  const seen = new Map<number, DevServerInfo>();

  for (const line of output.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    const name = parts[parts.length - 2]; // NAME column, before (LISTEN)

    // Extract port from formats like 127.0.0.1:3000 or [::1]:3000 or *:3000
    const portMatch = name.match(/:(\d+)$/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);

    // Deduplicate by port (IPv4 and IPv6 both show up)
    if (!seen.has(port)) {
      seen.set(port, { port, pid, process: command });
    }
  }

  return Array.from(seen.values());
}

export function parseLsofConnections(
  output: string,
  serverPid: number
): { inbound: Connection[]; outbound: Connection[] } {
  if (!output.trim()) return { inbound: [], outbound: [] };

  const inbound: Connection[] = [];
  const outbound: Connection[] = [];

  for (const line of output.split("\n")) {
    if (!line.includes("(ESTABLISHED)")) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const pid = parseInt(parts[1], 10);
    if (pid !== serverPid) continue;

    const name = parts[parts.length - 2]; // NAME column, before (ESTABLISHED)

    // Format: 127.0.0.1:3000->127.0.0.1:54321
    const connMatch = name.match(
      /^(.+):(\d+)->(.+):(\d+)$/
    );
    if (!connMatch) continue;

    const remoteAddr = connMatch[3];
    const remotePort = parseInt(connMatch[4], 10);
    const service = inferService(remotePort);

    const conn: Connection = {
      remoteAddr,
      remotePort,
      state: "ESTABLISHED",
      ...(service ? { service } : {}),
    };

    if (service) {
      outbound.push(conn);
    } else {
      inbound.push(conn);
    }
  }

  return { inbound, outbound };
}

// --- Dev server detection ---

export const DEV_PORTS = [3000, 3001, 4000, 4200, 5173, 5174, 8080, 8081, 1420];

export function detectDevServers(): DevServerInfo[] {
  try {
    const os = platform();
    let output: string;

    if (os === "darwin") {
      output = execSync("lsof -iTCP -sTCP:LISTEN -P -n", {
        encoding: "utf-8",
        timeout: 5000,
      });
    } else {
      output = execSync("ss -tlnp", {
        encoding: "utf-8",
        timeout: 5000,
      });
    }

    const listeners = parseLsofListeners(output);
    return listeners
      .filter((l) => DEV_PORTS.includes(l.port))
      .sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

// --- Network topology ---

export async function getNetworkTopology(
  server: DevServerInfo,
  cwd: string
): Promise<NetworkTopology> {
  try {
    const output = execSync(`lsof -i -P -n -p ${server.pid}`, {
      encoding: "utf-8",
      timeout: 5000,
    });

    const { inbound, outbound } = parseLsofConnections(output, server.pid);
    const missing = await detectMissingConnections(outbound, cwd);

    return {
      devServer: server,
      inbound,
      outbound,
      ...(missing.length > 0 ? { missing } : {}),
    };
  } catch {
    return {
      devServer: server,
      inbound: [],
      outbound: [],
    };
  }
}

// --- Missing connection detection ---

export async function detectMissingConnections(
  outbound: Connection[],
  cwd: string
): Promise<string[]> {
  const missing: string[] = [];

  let configEntries: Array<{
    source: string;
    key: string;
    value: string;
    persistence: "env-file" | "env-var";
  }>;
  try {
    // Lazy import to break circular dependency (capture.ts → network.ts → capture.ts)
    const { readConfigState } = await import("./capture.js");
    configEntries = readConfigState(cwd);
  } catch {
    return [];
  }

  const connectedPorts = new Set(outbound.map((c) => c.remotePort));

  for (const entry of configEntries) {
    const { key, value } = entry;

    // OLLAMA keys → expects connection to :11434 (or port from URL)
    if (key === "OLLAMA_BASE_URL" || key === "OLLAMA_HOST") {
      const portMatch = value.match(/:(\d+)/);
      const expectedPort = portMatch ? parseInt(portMatch[1], 10) : 11434;
      if (!connectedPorts.has(expectedPort)) {
        missing.push(
          `Expected connection to ${inferService(expectedPort) ?? "service"} on port ${expectedPort} (configured via ${key})`
        );
      }
    }

    // DATABASE_URL containing known DB ports
    if (key === "DATABASE_URL") {
      const dbPorts = [5432, 3306, 6379, 27017];
      for (const dbPort of dbPorts) {
        if (value.includes(`:${dbPort}`)) {
          if (!connectedPorts.has(dbPort)) {
            missing.push(
              `Expected connection to ${inferService(dbPort)} on port ${dbPort} (configured via DATABASE_URL)`
            );
          }
        }
      }
    }

    // OPENAI_BASE_URL pointing to localhost → expects connection to that port
    if (key === "OPENAI_BASE_URL" && /localhost|127\.0\.0\.1/.test(value)) {
      const portMatch = value.match(/:(\d+)/);
      if (portMatch) {
        const expectedPort = parseInt(portMatch[1], 10);
        if (!connectedPorts.has(expectedPort)) {
          missing.push(
            `Expected connection to local OpenAI-compatible server on port ${expectedPort} (configured via OPENAI_BASE_URL)`
          );
        }
      }
    }
  }

  return missing;
}

// --- Topology cache ---

let topologyCache: { result: NetworkTopology; timestamp: number } | null = null;
const TOPOLOGY_TTL_MS = 10_000;

export async function getCachedTopology(cwd: string): Promise<NetworkTopology | null> {
  const now = Date.now();

  if (topologyCache && now - topologyCache.timestamp < TOPOLOGY_TTL_MS) {
    return topologyCache.result;
  }

  const servers = detectDevServers();
  if (servers.length === 0) return null;

  const result = await getNetworkTopology(servers[0], cwd);
  topologyCache = { result, timestamp: now };
  return result;
}

export function clearTopologyCache(): void {
  topologyCache = null;
}
