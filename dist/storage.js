/**
 * storage.ts — Team memory backend for shared debugging knowledge.
 *
 * Local memory (memory.ts) remains primary and unchanged.
 * This module adds team sync: push local entries to StackPack platform,
 * pull team knowledge on recall, merge results.
 *
 * Requires STACKPACK_EVENTS_URL + STACKPACK_API_KEY env vars.
 * Degrades gracefully: if not configured or unreachable, returns empty.
 */
// --- Team Memory Client ---
export class TeamMemoryClient {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        // Normalize: ensure base URL ends without trailing slash
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.apiKey = apiKey;
    }
    /**
     * Create a client from environment variables.
     * Returns null if not configured.
     */
    static fromEnv() {
        const url = process.env.STACKPACK_EVENTS_URL;
        const key = process.env.STACKPACK_API_KEY;
        if (!url || !key)
            return null;
        // Derive debug memory API base URL from events URL.
        // STACKPACK_EVENTS_URL may be:
        //   https://host.fly.dev/api/events/myproject
        //   https://host.fly.dev/api/events
        //   https://host.fly.dev
        // We need the origin: https://host.fly.dev
        // Then our endpoints are at /api/debug/memories/*
        let base;
        try {
            const parsed = new URL(url);
            base = parsed.origin; // https://host.fly.dev
        }
        catch {
            // Fallback: strip everything after the host
            base = url.replace(/\/(api\/)?events\/?.*$/, "");
        }
        return new TeamMemoryClient(base, key);
    }
    /**
     * Check if the platform is reachable and healthy.
     * Returns status info for display to the user.
     */
    async checkHealth() {
        try {
            const res = await fetch(`${this.baseUrl}/api/health`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                return {
                    reachable: true,
                    status: `unhealthy (HTTP ${res.status})`,
                    error: `Platform responded with ${res.status}`,
                    troubleshooting: [
                        res.status === 401 ? "API key may be invalid or expired. Check STACKPACK_API_KEY." : "",
                        res.status === 503 ? "Platform is starting up. Wait 10-15 seconds and retry." : "",
                        `Check platform logs: fly logs --app stackpack-platform`,
                    ].filter(Boolean),
                };
            }
            const data = await res.json();
            return {
                reachable: true,
                status: "healthy",
                uptime: data.uptime,
                services: data.services,
            };
        }
        catch (err) {
            const message = String(err);
            const isTimeout = message.includes("timeout") || message.includes("abort");
            const isDns = message.includes("ENOTFOUND") || message.includes("getaddrinfo");
            return {
                reachable: false,
                status: "unreachable",
                error: message,
                troubleshooting: [
                    isTimeout
                        ? "Platform may be sleeping. Fly machines auto-wake but need 5-10s. Retry in a moment."
                        : isDns
                            ? `DNS resolution failed for ${this.baseUrl}. Check STACKPACK_EVENTS_URL.`
                            : `Network error connecting to ${this.baseUrl}.`,
                    "Verify: curl -s " + this.baseUrl + "/api/health",
                    "Check machine: fly status --app stackpack-platform",
                    "Wake machine: fly machine start --app stackpack-platform",
                ],
            };
        }
    }
    /**
     * Push local memory entries to the team pool.
     * Deduplicates by error signature on the server side.
     */
    async push(entries) {
        try {
            const res = await fetch(`${this.baseUrl}/api/debug/memories`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ entries }),
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                return { synced: 0, conflicts: 0, errors: [`HTTP ${res.status}`] };
            }
            return await res.json();
        }
        catch (err) {
            return { synced: 0, conflicts: 0, errors: [String(err)] };
        }
    }
    /**
     * Pull new team entries since a timestamp.
     */
    async pull(since) {
        try {
            const params = new URLSearchParams({ since });
            const res = await fetch(`${this.baseUrl}/api/debug/memories/pull?${params}`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                return { entries: [], cursor: since };
            }
            return await res.json();
        }
        catch {
            return { entries: [], cursor: since };
        }
    }
    /**
     * Search team memory for past solutions.
     * Falls back to empty results on any error.
     */
    async recall(query, opts = {}) {
        try {
            const res = await fetch(`${this.baseUrl}/api/debug/memories/recall`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query,
                    errorSignature: opts.errorSignature,
                    sourceFile: opts.sourceFile,
                    limit: opts.limit ?? 5,
                    projectSlug: opts.projectSlug,
                    scope: opts.scope ?? "project",
                }),
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok)
                return [];
            const data = await res.json();
            return data.results ?? [];
        }
        catch {
            return [];
        }
    }
    /**
     * Report outcome for a recalled entry — closes the feedback loop.
     * Increments times_applied + times_succeeded/times_failed on the server.
     */
    async reportOutcome(entryId, outcome) {
        try {
            await fetch(`${this.baseUrl}/api/debug/memories/${entryId}/outcome`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(outcome),
                signal: AbortSignal.timeout(3000),
            });
        }
        catch {
            // Silent — outcome reporting must never break debug
        }
    }
}
/**
 * Merge local recall results with team recall results.
 * Local results always rank first. Team results fill remaining slots.
 * Entries matching failedApproaches get annotated.
 */
export function mergeRecallResults(local, team, limit, failedApproaches) {
    const results = [];
    // Local results first
    for (const r of local) {
        if (results.length >= limit)
            break;
        results.push({ ...r, source: "local" });
    }
    // Team results fill remaining
    if (team.length > 0 && results.length < limit) {
        // Deduplicate: skip team entries that overlap with local by problem text
        const localProblems = new Set(local.map((r) => r.problem?.toLowerCase?.()).filter(Boolean));
        for (const t of team) {
            if (results.length >= limit)
                break;
            if (t.superseded)
                continue;
            if (localProblems.has(t.entry.problem?.toLowerCase()))
                continue;
            // Check against failed approaches
            let warning;
            if (failedApproaches?.length) {
                const diagLower = t.entry.diagnosis.toLowerCase();
                const match = failedApproaches.find((fa) => diagLower.includes(fa.toLowerCase()) || fa.toLowerCase().includes(diagLower));
                if (match) {
                    warning = `WARNING: similar approach was already tried this session and failed: "${match}"`;
                }
            }
            results.push({ ...t, failedApproachWarning: warning });
        }
    }
    return results;
}
//# sourceMappingURL=storage.js.map