import { describe, it, expect } from "vitest";
import { parseLsofListeners, parseLsofConnections, detectDevServers, inferService } from "../src/network.js";

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
