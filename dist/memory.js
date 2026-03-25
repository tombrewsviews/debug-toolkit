/**
 * memory.ts — Debug session memory across conversations.
 *
 * Three tiers of intelligence:
 *   1. Recall — search past diagnoses for similar errors (keyword overlap)
 *   2. Staleness — flag outdated diagnoses when code has changed since
 *   3. Patterns — detect recurring errors, hot files, regression trends
 *
 * Implementation: JSON file + in-memory inverted index.
 * Zero native dependencies. Fast enough for hundreds of sessions.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeConfidence, ARCHIVE_THRESHOLD } from "./confidence.js";
import { memoryPath, atomicWrite, tokenize } from "./utils.js";
// ━━━ Inverted Index Cache ━━━
let invertedIndex = null;
let indexedStorePath = null;
function buildIndex(store) {
    const idx = new Map();
    for (const entry of store.entries) {
        for (const kw of entry.keywords) {
            if (!idx.has(kw))
                idx.set(kw, new Set());
            idx.get(kw).add(entry.id);
        }
    }
    return idx;
}
function getIndex(cwd, store) {
    const p = memoryPath(cwd);
    if (invertedIndex && indexedStorePath === p)
        return invertedIndex;
    invertedIndex = buildIndex(store);
    indexedStorePath = p;
    return invertedIndex;
}
function invalidateIndex() {
    invertedIndex = null;
    indexedStorePath = null;
}
// ━━━ Git helpers ━━━
function getGitSha(cwd) {
    try {
        return execSync("git rev-parse --short HEAD 2>/dev/null", { cwd, timeout: 3000 })
            .toString().trim() || null;
    }
    catch {
        return null;
    }
}
function isValidSha(sha) {
    return /^[0-9a-f]{7,40}$/i.test(sha);
}
/**
 * Batch-fetch commit counts for multiple files since a given SHA.
 * Single git process instead of one per file.
 */
function batchCommitCounts(cwd, baseSha, files) {
    const counts = new Map();
    if (files.length === 0)
        return counts;
    try {
        const result = execSync(`git log --format="" --name-only ${baseSha}..HEAD -- ${files.map(f => `"${f}"`).join(" ")}`, { cwd, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString();
        for (const line of result.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) {
                counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
            }
        }
    }
    catch {
        // Git not available or SHA not found — treat all as unknown
    }
    // Ensure all requested files have an entry (0 if not changed)
    for (const f of files) {
        if (!counts.has(f))
            counts.set(f, 0);
    }
    return counts;
}
function checkStaleness(cwd, entry) {
    if (!entry.gitSha || !isValidSha(entry.gitSha)) {
        return { stale: false, reason: null, commitsBehind: 0, filesChanged: [] };
    }
    let totalCommits = 0;
    const changed = [];
    // Collect files to check via git (skip deleted files — they're stale immediately)
    const deletedFiles = [];
    const filesToCheck = [];
    for (const f of entry.files) {
        const fullPath = resolve(cwd, f);
        if (!existsSync(fullPath)) {
            deletedFiles.push(f);
            totalCommits += 1; // file deleted = definitely stale
        }
        else {
            filesToCheck.push(f);
        }
    }
    changed.push(...deletedFiles);
    // Also include causeFile if distinct
    const causeFile = entry.rootCause?.causeFile;
    if (causeFile && !entry.files.includes(causeFile)) {
        filesToCheck.push(causeFile);
    }
    // Single git call for all remaining files
    if (filesToCheck.length > 0) {
        const counts = batchCommitCounts(cwd, entry.gitSha, filesToCheck);
        for (const f of filesToCheck) {
            const n = counts.get(f) ?? 0;
            if (n > 0) {
                changed.push(f);
                totalCommits += n;
            }
        }
    }
    if (changed.length === 0)
        return { stale: false, reason: null, commitsBehind: 0, filesChanged: [] };
    return {
        stale: true,
        reason: `${changed.length} file(s) changed in ${totalCommits} commit(s) since this diagnosis`,
        commitsBehind: totalCommits,
        filesChanged: changed,
    };
}
/**
 * Detect patterns across all stored debug sessions.
 * Cheap — just scans the JSON array, no external calls.
 */
export function detectPatterns(cwd) {
    const store = loadStore(cwd);
    if (store.entries.length < 2)
        return [];
    const insights = [];
    // 1. Recurring errors — same errorType in the same file
    const errorFileMap = new Map();
    for (const e of store.entries) {
        for (const f of e.files) {
            const key = `${e.errorType}:${f}`;
            const arr = errorFileMap.get(key);
            if (arr)
                arr.push(e);
            else
                errorFileMap.set(key, [e]);
        }
    }
    for (const [key, entries] of errorFileMap) {
        if (entries.length >= 3) {
            const [errType, file] = key.split(":", 2);
            insights.push({
                type: "recurring_error",
                severity: entries.length >= 5 ? "critical" : "warning",
                message: `${errType} has occurred ${entries.length} times in ${file}`,
                data: { errorType: errType, file, count: entries.length, dates: entries.map((e) => e.timestamp) },
            });
        }
    }
    // 2. Hot files — files that appear in many debug sessions
    const fileCount = new Map();
    for (const e of store.entries) {
        for (const f of e.files) {
            fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
        }
    }
    const threshold = Math.max(3, Math.ceil(store.entries.length * 0.15));
    for (const [file, count] of fileCount) {
        if (count >= threshold) {
            insights.push({
                type: "hot_file",
                severity: count >= threshold * 2 ? "critical" : "warning",
                message: `${file} appears in ${count}/${store.entries.length} debug sessions (${Math.round(count / store.entries.length * 100)}%)`,
                data: { file, sessions: count, total: store.entries.length },
            });
        }
    }
    // 3. Regressions — same problem diagnosed more than once (diagnosis keywords overlap)
    for (let i = store.entries.length - 1; i >= 1; i--) {
        const current = store.entries[i];
        for (let j = i - 1; j >= Math.max(0, i - 20); j--) { // only check recent 20
            const past = store.entries[j];
            if (current.id === past.id)
                continue;
            // Check if same files AND same errorType — likely a regression
            const sharedFiles = current.files.filter((f) => past.files.includes(f));
            if (sharedFiles.length > 0 && current.errorType === past.errorType) {
                insights.push({
                    type: "regression",
                    severity: "warning",
                    message: `Possible regression: ${current.errorType} in ${sharedFiles[0]} was fixed before (${past.timestamp.slice(0, 10)}) but reappeared`,
                    data: {
                        currentId: current.id, pastId: past.id,
                        file: sharedFiles[0], errorType: current.errorType,
                        pastDiagnosis: past.diagnosis, currentProblem: current.problem,
                    },
                });
                break; // Only report the most recent regression per entry
            }
        }
    }
    // 4. Error clusters — multiple different errors happening in a short time window
    const sorted = [...store.entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (let i = 0; i < sorted.length - 2; i++) {
        const window = sorted.slice(i, i + 3);
        const t0 = new Date(window[0].timestamp).getTime();
        const t2 = new Date(window[2].timestamp).getTime();
        const hoursDiff = (t2 - t0) / (1000 * 60 * 60);
        if (hoursDiff < 2 && hoursDiff > 0) {
            const uniqueErrors = new Set(window.map((e) => e.errorType));
            if (uniqueErrors.size >= 2) {
                insights.push({
                    type: "error_cluster",
                    severity: "info",
                    message: `${window.length} errors in ${Math.round(hoursDiff * 60)} minutes — possible cascading failure`,
                    data: {
                        errors: window.map((e) => ({ type: e.errorType, file: e.files[0], time: e.timestamp })),
                        timeWindowMinutes: Math.round(hoursDiff * 60),
                    },
                });
                i += 2; // Skip past this cluster
            }
        }
    }
    return insights;
}
// ━━━ Paths & Persistence ━━━
function loadStore(cwd) {
    const p = memoryPath(cwd);
    if (!existsSync(p))
        return { version: 2, entries: [] };
    try {
        const store = JSON.parse(readFileSync(p, "utf-8"));
        // Migrate v1 entries (no gitSha/rootCause)
        for (const e of store.entries) {
            if (e.gitSha === undefined)
                e.gitSha = null;
            if (e.rootCause === undefined)
                e.rootCause = null;
        }
        store.version = 2;
        for (const e of store.entries) {
            if (e.timesRecalled === undefined)
                e.timesRecalled = 0;
            if (e.timesUsed === undefined)
                e.timesUsed = 0;
            if (e.archived === undefined)
                e.archived = false;
        }
        return store;
    }
    catch {
        return { version: 2, entries: [] };
    }
}
function saveStore(cwd, store) {
    atomicWrite(memoryPath(cwd), JSON.stringify(store, null, 2));
    invalidateIndex();
}
// ━━━ Public API ━━━
/**
 * Save a completed debug session to memory.
 * Auto-captures the current git SHA for staleness tracking.
 */
export function remember(cwd, entry) {
    const store = loadStore(cwd);
    const allText = [
        entry.problem, entry.errorType, entry.category, entry.diagnosis,
        ...entry.files,
        entry.rootCause?.trigger ?? "",
        entry.rootCause?.fixDescription ?? "",
    ].join(" ");
    const keywords = [...new Set(tokenize(allText))];
    const full = {
        ...entry,
        keywords,
        gitSha: getGitSha(cwd),
        rootCause: entry.rootCause ?? null,
        timesRecalled: 0,
        timesUsed: 0,
        archived: false,
    };
    store.entries = store.entries.filter((e) => e.id !== full.id);
    store.entries.push(full);
    if (store.entries.length > 200) {
        store.entries = store.entries.slice(-200);
    }
    saveStore(cwd, store);
    return full;
}
/**
 * Search past debug sessions for similar errors.
 * Returns matches ranked by confidence * relevance, with staleness info and causal chains.
 */
export function recall(cwd, query, limit = 5) {
    const store = loadStore(cwd);
    if (store.entries.length === 0)
        return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0)
        return [];
    const now = Date.now();
    const index = getIndex(cwd, store);
    // Build candidate set using inverted index: map entryId → hit count
    const hitCounts = new Map();
    for (const qt of queryTokens) {
        // Collect all index entries that overlap with this token (substring match)
        for (const [kw, idSet] of index) {
            if (kw.includes(qt) || qt.includes(kw)) {
                for (const id of idSet) {
                    hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1);
                }
            }
        }
    }
    // Build a lookup map for quick entry access
    const entryById = new Map();
    for (const e of store.entries) {
        entryById.set(e.id, e);
    }
    const scored = [];
    for (const [id, hits] of hitCounts) {
        const entry = entryById.get(id);
        if (!entry || entry.archived)
            continue;
        const relevance = hits / queryTokens.length;
        const staleness = checkStaleness(cwd, entry);
        const ageInDays = (now - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        const confidence = computeConfidence({
            ageInDays,
            fileDriftCommits: staleness.commitsBehind,
            timesRecalled: entry.timesRecalled,
            timesUsed: entry.timesUsed,
        });
        scored.push({ ...entry, relevance, staleness, confidence });
    }
    const results = scored
        .filter((e) => e.relevance > 0.2)
        .sort((a, b) => {
        // Sort by combined confidence * relevance score
        return (b.confidence * b.relevance) - (a.confidence * a.relevance);
    })
        .slice(0, limit);
    // Increment timesRecalled for matched entries and save
    if (results.length > 0) {
        const resultIds = new Set(results.map((r) => r.id));
        for (const entry of store.entries) {
            if (resultIds.has(entry.id)) {
                entry.timesRecalled = (entry.timesRecalled ?? 0) + 1;
            }
        }
        saveStore(cwd, store);
    }
    return results;
}
/**
 * Archive memories with confidence below threshold for 30+ days.
 * Archived memories are excluded from auto-recall.
 */
export function archiveStaleMemories(cwd) {
    const store = loadStore(cwd);
    let archived = 0;
    for (const entry of store.entries) {
        if (entry.archived)
            continue;
        const ageInDays = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays < 30)
            continue;
        const staleness = checkStaleness(cwd, entry);
        const confidence = computeConfidence({
            ageInDays,
            fileDriftCommits: staleness.commitsBehind,
            timesRecalled: entry.timesRecalled ?? 0,
            timesUsed: entry.timesUsed ?? 0,
        });
        if (confidence < ARCHIVE_THRESHOLD) {
            entry.archived = true;
            archived++;
        }
    }
    if (archived > 0)
        saveStore(cwd, store);
    return { archived };
}
/**
 * Get memory stats.
 */
export function memoryStats(cwd) {
    // Auto-archive stale entries on stats check
    archiveStaleMemories(cwd);
    const store = loadStore(cwd);
    if (store.entries.length === 0) {
        return { entries: 0, oldestDate: null, newestDate: null, patterns: [] };
    }
    return {
        entries: store.entries.length,
        oldestDate: store.entries[0].timestamp,
        newestDate: store.entries[store.entries.length - 1].timestamp,
        patterns: detectPatterns(cwd),
    };
}
//# sourceMappingURL=memory.js.map