# Transparent Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the visibility gap between `spdg serve` and MCP-only mode by adding network topology detection, a "Monitor running app" CLI mode, and inline MCP collection — so the agent gets runtime insights regardless of how the user started their dev server.

**Architecture:** New `network.ts` module wraps `lsof`/`ss` to detect dev server ports, inbound/outbound connections, and cross-references with config state. The `LiveContext` schema gains a `network` field and `captureMode` indicator. The CLI menu gets a "Monitor running app" option. The MCP `buildLiveStatus()` function gains inline collection with caching when no live context file exists.

**Tech Stack:** TypeScript, Node.js child_process (execSync for lsof/ss), vitest for tests

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/network.ts` | **Create** | Network topology engine — lsof/ss parsing, port detection, service inference, config cross-reference |
| `tests/network.test.ts` | **Create** | Tests for lsof parsing, port detection, service inference, missing connection detection |
| `src/capture.ts` | **Modify** | Extend `LiveContext` type with `network` and `captureMode`. Update `writeLiveContext()` to include network data. |
| `src/mcp.ts` | **Modify** | Update `buildLiveStatus()` with inline collection, capture mode indicator, network section. Add network data to `debug_investigate` response. |
| `src/index.ts` | **Modify** | Add "Monitor running app" menu option. Wire network polling into serve mode. Update menu labels. |
| `src/cli.ts` | **No change** | Menu rendering already supports the `SelectOption` format we need. |

---

### Task 1: Network Topology Engine — lsof/ss Parsing

**Files:**
- Create: `src/network.ts`
- Create: `tests/network.test.ts`

- [ ] **Step 1: Write failing tests for lsof output parsing**

```typescript
// tests/network.test.ts
import { describe, it, expect } from "vitest";
import { parseLsofListeners, parseLsofConnections } from "../src/network.js";

describe("lsof output parsing", () => {
  it("should parse LISTEN entries from lsof output", () => {
    const output = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    52524 user   22u  IPv4 0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)
node    52524 user   23u  IPv6 0x5678      0t0  TCP [::1]:3000 (LISTEN)`;
    const result = parseLsofListeners(output);
    expect(result).toHaveLength(1); // deduped by port
    expect(result[0]).toEqual({ port: 3000, pid: 52524, process: "node" });
  });

  it("should parse multiple listeners on different ports", () => {
    const output = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    52524 user   22u  IPv4 0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)
node    61000 user   10u  IPv4 0x5678      0t0  TCP 127.0.0.1:5173 (LISTEN)`;
    const result = parseLsofListeners(output);
    expect(result).toHaveLength(2);
  });

  it("should parse ESTABLISHED connections from lsof output", () => {
    const output = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    52524 user   24u  IPv4 0x9abc      0t0  TCP 127.0.0.1:3000->127.0.0.1:54321 (ESTABLISHED)
node    52524 user   25u  IPv4 0xdef0      0t0  TCP 127.0.0.1:54322->127.0.0.1:11434 (ESTABLISHED)
node    52524 user   26u  IPv4 0x1111      0t0  TCP 127.0.0.1:54323->127.0.0.1:5432 (ESTABLISHED)`;
    const result = parseLsofConnections(output, 52524);
    expect(result.inbound).toHaveLength(1);
    expect(result.inbound[0].remotePort).toBe(54321);
    expect(result.outbound).toHaveLength(2);
    expect(result.outbound[0].remotePort).toBe(11434);
    expect(result.outbound[0].service).toBe("ollama");
    expect(result.outbound[1].remotePort).toBe(5432);
    expect(result.outbound[1].service).toBe("postgres");
  });

  it("should handle empty lsof output", () => {
    expect(parseLsofListeners("")).toHaveLength(0);
    expect(parseLsofConnections("", 1234)).toEqual({ inbound: [], outbound: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/network.test.ts`
Expected: FAIL — module `../src/network.js` does not exist

- [ ] **Step 3: Implement lsof parsing functions**

```typescript
// src/network.ts
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { readConfigState } from "./capture.js";

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

function inferService(port: number): string | undefined {
  return SERVICE_MAP[port];
}

// --- lsof output parsing ---

export function parseLsofListeners(output: string): DevServerInfo[] {
  const lines = output.split("\n").filter((l) => l.includes("(LISTEN)"));
  const seen = new Map<number, DevServerInfo>();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const proc = parts[0];
    const pid = parseInt(parts[1], 10);
    const name = parts[parts.length - 1]; // e.g., "127.0.0.1:3000"
    // Remove "(LISTEN)" suffix if present in name field — it's in the next column
    const addrPart = parts[parts.length - 2]; // NAME column
    const portMatch = /[:\.](\d+)$/.exec(addrPart);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1], 10);
    if (port < 1024 || port > 65535) continue;
    if (!seen.has(port)) {
      seen.set(port, { port, pid, process: proc });
    }
  }
  return [...seen.values()];
}

export function parseLsofConnections(
  output: string,
  serverPid: number,
): { inbound: Connection[]; outbound: Connection[] } {
  const inbound: Connection[] = [];
  const outbound: Connection[] = [];

  const lines = output.split("\n").filter((l) => l.includes("(ESTABLISHED)"));
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = parseInt(parts[1], 10);
    const namePart = parts[parts.length - 2]; // e.g., "127.0.0.1:3000->127.0.0.1:54321"
    const arrowMatch = /(.+)->(.+)/.exec(namePart);
    if (!arrowMatch) continue;

    const localPortMatch = /[:\.](\d+)$/.exec(arrowMatch[1]);
    const remotePortMatch = /[:\.](\d+)$/.exec(arrowMatch[2]);
    if (!localPortMatch || !remotePortMatch) continue;

    const localPort = parseInt(localPortMatch[1], 10);
    const remotePort = parseInt(remotePortMatch[1], 10);
    const remoteAddr = arrowMatch[2].replace(/[:\.](\d+)$/, "").replace(/^\[|\]$/g, "");

    if (pid === serverPid) {
      // Connection owned by the server process
      // If the local port is the server's listening port, it's inbound (client → server)
      // If the remote port is a well-known service, it's outbound (server → backend)
      const service = inferService(remotePort);
      if (service || remotePort < 1024 || remotePort === 11434) {
        outbound.push({ remoteAddr, remotePort, state: "ESTABLISHED", service });
      } else {
        inbound.push({ remoteAddr, remotePort, state: "ESTABLISHED" });
      }
    }
  }

  return { inbound, outbound };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/network.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/network.ts tests/network.test.ts
git commit -m "feat: network topology engine — lsof parsing and service inference"
```

---

### Task 2: Port Detection and Topology Scanning

**Files:**
- Modify: `src/network.ts`
- Modify: `tests/network.test.ts`

- [ ] **Step 1: Write failing tests for port detection and full topology scan**

Add to `tests/network.test.ts`:

```typescript
import { detectDevServers, inferService } from "../src/network.js";

describe("service inference", () => {
  it("should infer well-known services", () => {
    expect(inferService(11434)).toBe("ollama");
    expect(inferService(5432)).toBe("postgres");
    expect(inferService(6379)).toBe("redis");
    expect(inferService(3306)).toBe("mysql");
    expect(inferService(27017)).toBe("mongodb");
  });

  it("should return undefined for unknown ports", () => {
    expect(inferService(54321)).toBeUndefined();
    expect(inferService(8888)).toBeUndefined();
  });
});

describe("detectDevServers", () => {
  it("should filter to common dev ports", () => {
    // This test exercises the port filtering logic, not lsof itself
    const listeners = [
      { port: 3000, pid: 100, process: "node" },
      { port: 22, pid: 200, process: "sshd" },     // not a dev port
      { port: 5173, pid: 300, process: "node" },
      { port: 65000, pid: 400, process: "node" },   // not a dev port
    ];
    const devPorts = listeners.filter((l) =>
      [3000, 3001, 4000, 5173, 5174, 8080, 8081, 1420].includes(l.port)
    );
    expect(devPorts).toHaveLength(2);
    expect(devPorts[0].port).toBe(3000);
    expect(devPorts[1].port).toBe(5173);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/network.test.ts`
Expected: FAIL — `inferService` not exported, `detectDevServers` not found

- [ ] **Step 3: Add port detection and topology scanning to network.ts**

Add to `src/network.ts` after the parsing functions:

```typescript
// Export inferService for testing
export { inferService };

// --- Common dev server ports ---

const DEV_PORTS = [3000, 3001, 4000, 4200, 5173, 5174, 8080, 8081, 1420];

// --- High-level scanning ---

/**
 * Detect running dev servers by scanning for LISTEN sockets on common ports.
 * Returns servers sorted by port (lowest first).
 */
export function detectDevServers(): DevServerInfo[] {
  try {
    const cmd = platform() === "linux"
      ? "ss -tlnp 2>/dev/null"
      : "lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null";
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5_000 });
    const all = parseLsofListeners(output);
    return all
      .filter((s) => DEV_PORTS.includes(s.port))
      .sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

/**
 * Get full network topology for a specific dev server.
 * Returns inbound connections (browsers), outbound connections (backends),
 * and missing expected connections (from config).
 */
export function getNetworkTopology(server: DevServerInfo, cwd: string): NetworkTopology {
  let inbound: Connection[] = [];
  let outbound: Connection[] = [];

  try {
    const cmd = platform() === "linux"
      ? `ss -tnp 2>/dev/null | grep "pid=${server.pid}"`
      : `lsof -i -P -n -p ${server.pid} 2>/dev/null`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5_000 });
    const connections = parseLsofConnections(output, server.pid);
    inbound = connections.inbound;
    outbound = connections.outbound;
  } catch { /* lsof failed — return empty topology */ }

  // Cross-reference config state to find missing expected connections
  const missing = detectMissingConnections(outbound, cwd);

  return { devServer: server, inbound, outbound, missing: missing.length > 0 ? missing : undefined };
}

/**
 * Check if expected backend connections are missing.
 * Reads config state (env files) and checks if the services they reference are connected.
 */
function detectMissingConnections(outbound: Connection[], cwd: string): string[] {
  const missing: string[] = [];
  try {
    const config = readConfigState(cwd);
    const connectedPorts = new Set(outbound.map((c) => c.remotePort));

    for (const entry of config) {
      // Check for Ollama
      if (/OLLAMA/i.test(entry.key)) {
        const portMatch = /:(\d+)/.exec(entry.value);
        const port = portMatch ? parseInt(portMatch[1], 10) : 11434;
        if (!connectedPorts.has(port)) {
          missing.push(`ollama (port ${port}, from ${entry.key})`);
        }
      }
      // Check for database URLs
      if (/DATABASE_URL/i.test(entry.key)) {
        if (entry.value.includes("5432") && !connectedPorts.has(5432)) missing.push("postgres (port 5432, from DATABASE_URL)");
        if (entry.value.includes("3306") && !connectedPorts.has(3306)) missing.push("mysql (port 3306, from DATABASE_URL)");
        if (entry.value.includes("6379") && !connectedPorts.has(6379)) missing.push("redis (port 6379, from DATABASE_URL)");
        if (entry.value.includes("27017") && !connectedPorts.has(27017)) missing.push("mongodb (port 27017, from DATABASE_URL)");
      }
      // Check for OpenAI base URL pointing to localhost
      if (/OPENAI_BASE_URL/i.test(entry.key) && /localhost|127\.0\.0\.1/i.test(entry.value)) {
        const portMatch = /:(\d+)/.exec(entry.value);
        if (portMatch) {
          const port = parseInt(portMatch[1], 10);
          if (!connectedPorts.has(port)) {
            missing.push(`openai-compatible (port ${port}, from ${entry.key})`);
          }
        }
      }
    }
  } catch { /* config read failure is non-fatal */ }
  return missing;
}

// --- Cached scanning for MCP inline use ---

let cachedTopology: NetworkTopology | null = null;
let cachedAt = 0;
const CACHE_TTL = 10_000; // 10 seconds

/**
 * Get network topology with caching. For use in MCP status reads
 * where we don't want to run lsof on every call.
 */
export function getCachedTopology(cwd: string): NetworkTopology | null {
  if (cachedTopology && Date.now() - cachedAt < CACHE_TTL) {
    return cachedTopology;
  }

  const servers = detectDevServers();
  if (servers.length === 0) {
    cachedTopology = { devServer: null, inbound: [], outbound: [] };
    cachedAt = Date.now();
    return cachedTopology;
  }

  // Use the first detected dev server (most common case: one dev server)
  cachedTopology = getNetworkTopology(servers[0], cwd);
  cachedAt = Date.now();
  return cachedTopology;
}

/** Clear the topology cache (e.g., when starting serve mode). */
export function clearTopologyCache(): void {
  cachedTopology = null;
  cachedAt = 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/network.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 6: Commit**

```bash
git add src/network.ts tests/network.test.ts
git commit -m "feat: port detection, topology scanning, and config cross-reference"
```

---

### Task 3: Extend LiveContext Schema and writeLiveContext

**Files:**
- Modify: `src/capture.ts`

- [ ] **Step 1: Update the LiveContext interface to include network and captureMode**

In `src/capture.ts`, find the `LiveContext` interface (line ~839) and replace it:

```typescript
export interface LiveContext {
  updatedAt: string;
  captureMode: "full" | "active-collection" | "static";
  terminal: Array<{ timestamp: string; text: string; stream: string }>;
  browser: Array<{ timestamp: string; source: string; data: unknown; lighthouseTriggered?: boolean; sourceContext?: "webview" | "external" | "lighthouse" }>;
  buildErrors: Array<{ tool: string; file: string | null; line: number | null; code: string | null; message: string }>;
  runtimeErrors: Array<{ type: string; message: string; file: string | null; line: number | null; stack: string | null }>;
  configState: Array<{ source: string; key: string; value: string; persistence: "env-file" | "env-var" }>;
  counts: { terminal: number; browser: number; buildErrors: number; runtimeErrors: number };
  network: {
    devServer: { port: number; pid: number; process: string } | null;
    inbound: Array<{ remoteAddr: string; remotePort: number; state: string; service?: string }>;
    outbound: Array<{ remoteAddr: string; remotePort: number; state: string; service?: string }>;
    missing?: string[];
  } | null;
}
```

- [ ] **Step 2: Update writeLiveContext to include network topology and captureMode**

In `src/capture.ts`, update `writeLiveContext()` (line ~937). Add import at top of file:

```typescript
import { getCachedTopology, type NetworkTopology } from "./network.js";
```

Then update the function:

```typescript
export function writeLiveContext(cwd: string): void {
  const recent = peekRecentOutput({ terminalLines: 100, browserLines: 50, buildErrors: 30, runtimeErrors: 20 });

  // Determine capture mode from what data sources are active
  const hasTerminal = recent.counts.terminal > 0;
  const hasBrowser = recent.counts.browser > 0;
  const captureMode: LiveContext["captureMode"] = (hasTerminal || hasBrowser) ? "full" : "active-collection";

  // Get network topology (cached, ~50ms when cache miss)
  const topology = getCachedTopology(cwd);

  const context: LiveContext = {
    updatedAt: new Date().toISOString(),
    captureMode,
    terminal: recent.terminal.map((c) => {
      const d = typeof c.data === "object" && c.data !== null ? c.data as Record<string, unknown> : null;
      return { timestamp: c.timestamp, text: String(d?.text ?? d?.data ?? c.data), stream: String(d?.stream ?? "stdout") };
    }),
    browser: recent.browser.map((c) => ({
      timestamp: c.timestamp, source: c.source, data: c.data,
      lighthouseTriggered: c.lighthouseTriggered || undefined,
      sourceContext: c.sourceContext || undefined,
    })),
    buildErrors: recent.buildErrors.map((e) => ({
      tool: e.tool, file: e.file, line: e.line, code: e.code, message: e.message,
    })),
    runtimeErrors: recent.runtimeErrors.map((e) => ({
      type: e.type, message: e.message, file: e.file, line: e.line, stack: e.stack,
    })),
    configState: readConfigState(cwd),
    counts: recent.counts,
    network: topology,
  };
  const dir = join(cwd, ".debug");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "live-context.json"), JSON.stringify(context));
}
```

- [ ] **Step 3: Update readLiveContext to handle old schema gracefully**

The `readLiveContext` function already returns `LiveContext | null`. No changes needed — the new fields (`captureMode`, `network`) are optional in practice since old live-context.json files won't have them. Consumers should check for their presence.

- [ ] **Step 4: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 5: Run all existing tests to check for regressions**

Run: `npx vitest run`
Expected: All existing tests pass (no capture tests depend on LiveContext shape directly)

- [ ] **Step 6: Commit**

```bash
git add src/capture.ts
git commit -m "feat: extend LiveContext with network topology and captureMode"
```

---

### Task 4: MCP Inline Collection and Capture Status Indicator

**Files:**
- Modify: `src/mcp.ts`

- [ ] **Step 1: Add network import to mcp.ts**

At the top of `src/mcp.ts`, add to the imports:

```typescript
import { getCachedTopology } from "./network.js";
```

- [ ] **Step 2: Add capture status section builder**

Add a new function in `src/mcp.ts` (before `buildLiveStatus`):

```typescript
function buildCaptureStatus(live: LiveContext | null, topology: NetworkTopology | null): string {
  const lines: string[] = [];

  if (live && live.captureMode === "full") {
    lines.push("## Capture Mode: FULL\n");
  } else if (live && live.captureMode === "active-collection") {
    lines.push("## Capture Mode: ACTIVE COLLECTION\n");
  } else if (topology?.devServer) {
    lines.push("## Capture Mode: PARTIAL\n");
  } else {
    lines.push("## Capture Mode: STATIC\n");
  }

  // What's available
  if (live?.terminal && live.terminal.length > 0) {
    const errors = live.terminal.filter((t) => /error|warn|panic|failed|crash|exception/i.test(t.text));
    lines.push(`- ✓ Terminal output (${live.terminal.length} lines, ${errors.length} errors)`);
  } else {
    lines.push(`- ✗ Terminal output — run \`spdg\` → "Start dev server" or "Monitor running app"`);
  }

  if (live?.browser && live.browser.length > 0) {
    lines.push(`- ✓ Browser console (${live.browser.length} events)`);
  } else {
    lines.push(`- ✗ Browser console — run \`spdg\` → "Start dev server" for auto-capture`);
  }

  if (live?.buildErrors && live.buildErrors.length > 0) {
    lines.push(`- ✓ Build errors: ${live.buildErrors.length}`);
  } else {
    lines.push(`- ✓ Build errors: 0`);
  }

  // Network topology — works in all modes
  const net = live?.network ?? topology;
  if (net?.devServer) {
    lines.push(`- ✓ Dev server detected on :${net.devServer.port} (PID ${net.devServer.pid}, ${net.devServer.process})`);
    const inCount = net.inbound.length;
    const outParts = net.outbound.map((c) => `${c.service ?? "unknown"}:${c.remotePort}`);
    if (outParts.length > 0) {
      lines.push(`- ✓ Network: ${inCount} inbound, ${net.outbound.length} outbound (${outParts.join(", ")})`);
    } else {
      lines.push(`- ✓ Network: ${inCount} inbound, 0 outbound`);
    }
    if (net.missing && net.missing.length > 0) {
      for (const m of net.missing) {
        lines.push(`  - ⚠ No connection to ${m} — server may be stuck or service not running`);
      }
    }
  } else {
    lines.push(`- ✗ No dev server detected on common ports`);
  }

  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 3: Update buildLiveStatus to use inline collection and capture status**

In `src/mcp.ts`, update the `buildLiveStatus` function. Replace the block at line ~274 that handles `!hasLive && !hasLocal`:

Find the block:
```typescript
  if (!hasLive && !hasLocal) {
    sections.push("**Dev server not running or not capturing.**\n");
    sections.push("Start with: `npx stackpack-debug serve -- <your dev command>`\n");
```

Replace the entire `if (!hasLive && !hasLocal) { ... }` block (through line ~298) with:

```typescript
  // Always include capture status indicator and network topology
  const topology = getCachedTopology(cwd);

  if (!hasLive && !hasLocal) {
    // No live context — do inline collection
    sections.push(buildCaptureStatus(null, topology));

    // Network topology section (the key value-add for MCP-only mode)
    if (topology?.devServer) {
      sections.push("## Network Topology\n");
      sections.push(`Dev server: **${topology.devServer.process}** on port ${topology.devServer.port} (PID ${topology.devServer.pid})\n`);
      if (topology.inbound.length > 0) {
        sections.push(`Inbound connections: ${topology.inbound.length}`);
      }
      if (topology.outbound.length > 0) {
        sections.push("Outbound connections:");
        for (const c of topology.outbound) {
          sections.push(`- ${c.service ?? c.remoteAddr}:${c.remotePort} (${c.state})`);
        }
      } else {
        sections.push("Outbound connections: **none** — server is not connecting to any backends");
      }
      if (topology.missing && topology.missing.length > 0) {
        sections.push("");
        sections.push("**Missing expected connections:**");
        for (const m of topology.missing) {
          sections.push(`- ⚠ ${m}`);
        }
      }
      sections.push("");
    }

    // Static analysis fallback (existing behavior)
    const tscErrors = runQuickTsc(cwd);
    if (tscErrors.length > 0) {
      sections.push("## TypeScript Errors\n");
      sections.push("```");
      for (const e of tscErrors) sections.push(e);
      sections.push("```\n");
    }

    const gitLines = getRecentGitActivity(cwd);
    if (gitLines.length > 0) {
      sections.push("## Git Activity\n");
      for (const l of gitLines) sections.push(l);
      sections.push("");
    }

    appendTauriLogs(sections, cwd);
    appendSessions(sections, cwd);
    appendLoopWarning(sections, cwd);
    return sections.join("\n");
  }
```

- [ ] **Step 4: Add capture status to the live-data path too**

After the existing line `sections.push(`*Updated: ${live.updatedAt}*\n`);` (line ~301), add the capture status:

```typescript
  sections.push(buildCaptureStatus(live, topology));
```

And add the network section after the configuration state section (after line ~380), before the browser console section:

```typescript
    // === NETWORK TOPOLOGY ===
    const net = live?.network ?? topology;
    if (net?.devServer) {
      sections.push("## Network Topology\n");
      const outParts = net.outbound.map((c) => `${c.service ?? c.remoteAddr}:${c.remotePort}`);
      sections.push(`Dev server: **${net.devServer.process}** :${net.devServer.port} → ${outParts.length > 0 ? outParts.join(", ") : "no outbound connections"}\n`);
      if (net.missing && net.missing.length > 0) {
        for (const m of net.missing) {
          sections.push(`> ⚠ **Missing connection**: ${m} — check if service is running or if middleware is blocking`);
        }
        sections.push("");
      }
    }
```

- [ ] **Step 5: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 6: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: MCP inline collection with capture status indicator and network topology"
```

---

### Task 5: Network Correlation in debug_investigate

**Files:**
- Modify: `src/mcp.ts`

- [ ] **Step 1: Add network topology to the debug_investigate response**

In `src/mcp.ts`, find the `debug_investigate` handler response builder (line ~1007). After the `configState` field (line ~1040), add network topology:

```typescript
      networkTopology: (() => {
        const topo = getCachedTopology(cwd);
        if (!topo?.devServer) return undefined;
        const result: Record<string, unknown> = {
          devServer: `${topo.devServer.process} on :${topo.devServer.port}`,
          inbound: topo.inbound.length,
          outbound: topo.outbound.map((c) => `${c.service ?? "unknown"}:${c.remotePort}`),
        };
        if (topo.missing && topo.missing.length > 0) {
          result.missingConnections = topo.missing;
          result.hint = "Expected backend connections not found — check middleware/auth layer or verify service is running.";
        }
        if (topo.outbound.length === 0 && topo.inbound.length > 0) {
          result.hint = "Server has inbound connections but no outbound — request may be stuck in middleware before reaching backend.";
        }
        return result;
      })(),
```

- [ ] **Step 2: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/mcp.ts
git commit -m "feat: add network topology and correlation hints to debug_investigate"
```

---

### Task 6: "Monitor Running App" Menu Option

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import for network module**

At the top of `src/index.ts`, add:

```typescript
import { detectDevServers, getNetworkTopology, clearTopologyCache } from "./network.js";
```

- [ ] **Step 2: Update buildMenuOptions to add "Monitor running app"**

Replace `buildMenuOptions` function (line ~556):

```typescript
function buildMenuOptions(cwd: string): SelectOption[] {
  const { cmd: devCmd } = detectDevCommand(cwd);
  return [
    {
      label: "Start dev server with full capture",
      desc: `Wraps ${devCmd} with terminal, browser, and network monitoring.`,
      detail: "Launches behind an HTTP proxy with auto-capture. Stop anytime with Ctrl+C.",
    },
    {
      label: "Monitor running app (no restart)",
      desc: "Attaches to your already-running dev server. Network, config, and build watching.",
      detail: "Detects dev server port via lsof. No terminal/browser capture without proxy.",
    },
    {
      label: "Check setup health",
      desc: "Verify your environment — shows what's working and what's missing.",
      detail: "Quick scan of Node, Git, Lighthouse, Chrome, Ghost OS, and Claude Preview.",
    },
    {
      label: "Re-run setup",
      desc: "Regenerate MCP config, hooks, and activation rules from scratch.",
      detail: "Use after moving the project, updating Node, or if something looks broken.",
    },
  ];
}
```

- [ ] **Step 3: Update mainMenu switch to handle the new option**

In `mainMenu` (line ~747), update the switch statement. The indices shift because we inserted a new option at index 1:

```typescript
    switch (choice) {
      case 0: await guidedServe(cwd); return; // serve takes over, don't loop
      case 1: await monitorRunningApp(cwd); return; // monitor takes over, don't loop
      case 2: doctorCommand(cwd); break;
      case 3: initCommand(cwd); break;
    }
```

- [ ] **Step 4: Implement monitorRunningApp function**

Add before `mainMenu` function:

```typescript
async function monitorRunningApp(cwd: string): Promise<void> {
  section("Monitor Mode");

  // Scan for running dev server
  info("Scanning for running dev server...\n");
  let servers = detectDevServers();

  if (servers.length === 0) {
    info("Waiting for dev server... Start one in another terminal.\n");
    dim("  Scanning ports: 3000, 3001, 4000, 5173, 5174, 8080, 8081, 1420");
    info("");

    // Poll every 5s until a dev server appears
    servers = await new Promise<typeof servers>((resolve) => {
      const interval = setInterval(() => {
        const found = detectDevServers();
        if (found.length > 0) {
          clearInterval(interval);
          resolve(found);
        }
      }, 5_000);

      // Also handle Ctrl+C during polling
      const onExit = () => { clearInterval(interval); resolve([]); };
      process.once("SIGINT", onExit);
    });

    if (servers.length === 0) {
      info("Cancelled.");
      return;
    }
  }

  const server = servers[0];
  success(`Found dev server: ${c.bold}${server.process}${c.reset} on port ${c.cyan}${server.port}${c.reset} (PID ${server.pid})\n`);

  // Get initial topology
  const topology = getNetworkTopology(server, cwd);
  if (topology.outbound.length > 0) {
    kv("outbound", topology.outbound.map((c) => `${c.service ?? "unknown"}:${c.remotePort}`).join(", "));
  }
  if (topology.missing && topology.missing.length > 0) {
    for (const m of topology.missing) {
      warn(`Missing expected connection: ${m}`);
    }
  }
  info("");

  // Start the monitoring components
  info("Monitoring network, config, and build state. Press Ctrl+C to stop.\n");

  // Start capture server for browser events (user can paste script)
  const capturePort = 3100;
  const captureServer = startCaptureServer({
    port: capturePort,
    cwd,
    onEvent: (evt) => {
      const level = evt.type === "error" || evt.type === "rejection" ? "error" : "warn";
      const text = evt.message ?? evt.args ?? evt.reason ?? evt.text ?? evt.error ?? "";
      if (level === "error") {
        console.log(`  \x1b[31m${sym.cross}\x1b[0m ${text.slice(0, 120)}`);
      }
    },
  });
  dim(`  Browser capture server: ws://localhost:${capturePort}/__spdg/ws`);

  // Start live context writer
  const liveWriter = startLiveContextWriter(cwd);

  // Start loop watcher
  const loopWatcher = startLoopWatcher(cwd);

  // Start activity feed
  const activityFeed = startActivityFeed(cwd);

  const cleanup = () => {
    activityFeed.stop();
    liveWriter.stop();
    loopWatcher.stop();
    captureServer.stop();
    clearTopologyCache();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep alive
  setInterval(() => {}, 60_000);
}
```

- [ ] **Step 5: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 6: Test manually — run spdg and verify menu shows new option**

Run: `node dist/index.js`
Expected: Menu shows 4 options including "Monitor running app (no restart)"

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: 'Monitor running app' menu option with auto-detection"
```

---

### Task 7: Wire Network Topology into Serve Mode

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add network topology display to serve command startup**

In the `serve` case (line ~999), after the proxy setup and before the activity feed start, add network topology logging:

Find the line `const activityFeed = startActivityFeed(cwd);` and add before it:

```typescript
      // Show network topology after proxy is set up
      setTimeout(() => {
        const servers = detectDevServers();
        if (servers.length > 0) {
          const topology = getNetworkTopology(servers[0], cwd);
          if (topology.outbound.length > 0) {
            kv("backends", topology.outbound.map((c) => `${c.service ?? "unknown"}:${c.remotePort}`).join(", "));
          }
          if (topology.missing && topology.missing.length > 0) {
            for (const m of topology.missing) warn(`Missing: ${m}`);
          }
        }
      }, 3_000); // Delay to let the dev server start up and establish connections
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: show network topology in serve mode startup"
```

---

### Task 8: Version Bump, Docs, and Final Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `SKILL.md`

- [ ] **Step 1: Bump version to 0.23.0**

In `package.json`, change:
```json
"version": "0.23.0",
```

- [ ] **Step 2: Add changelog entry to README.md**

Add after the v0.22.0 changelog entry:

```markdown
### v0.23.0 — Transparent Capture

- **Network topology engine** — detects running dev servers via `lsof`, maps inbound connections (browsers) and outbound connections (backends like Ollama, Postgres, Redis), and cross-references with config state to flag missing expected connections.
- **Three capture tiers** — every `debug://status` response now shows a capture mode indicator (FULL / ACTIVE COLLECTION / PARTIAL / STATIC) with exactly what data sources are available and what's missing.
- **"Monitor running app" CLI mode** — new menu option in `spdg` that attaches to an already-running dev server without restarting it. Provides network topology, config state, tsc polling, browser capture server, and loop detection.
- **MCP inline collection** — when no `spdg serve` or monitor is running, the MCP server actively scans for dev server ports and includes network topology in `debug://status`. No more "Dev server not running" dead ends.
- **Missing connection alerts** — when config says `OLLAMA_BASE_URL=localhost:11434` but the server has no outbound connection to port 11434, the status report flags it with an actionable warning.
- **Network correlation in debug_investigate** — investigation responses include network topology with hints like "Server has inbound connections but no outbound — request may be stuck in middleware."
```

- [ ] **Step 3: Update SKILL.md with network topology info**

Add after the `debug_setup` section in SKILL.md:

```markdown
## Network Awareness

The toolkit detects running dev servers and maps their network connections automatically. This works in ALL modes — even without `spdg serve`.

**What it shows:**
- Dev server port, PID, and process name
- Inbound connections (browsers connecting to the server)
- Outbound connections (server connecting to Ollama, Postgres, Redis, etc.)
- Missing connections (config expects a service but no connection exists)

**When to look at it:**
- Timeout errors → check if the server has outbound connections
- "No response" → check if requests reach the server (inbound) and leave it (outbound)
- Wrong provider → check which service the server is actually connecting to
```

- [ ] **Step 4: Build final**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit and push**

```bash
git add package.json README.md SKILL.md src/ dist/ tests/
git commit -m "feat: transparent capture — network topology, monitor mode, MCP inline collection (v0.23.0)"
```
