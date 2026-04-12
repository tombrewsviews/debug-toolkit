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
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { computeConfidence, ARCHIVE_THRESHOLD } from "./confidence.js";
import { memoryPath, walPath, archiveDirPath, atomicWrite, tokenize } from "./utils.js";
import { signatureFromError } from "./signature.js";
const indexCacheMap = new Map();
const MAX_CACHED_PROJECTS = 5;
let storeGeneration = 0;
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
    const cached = indexCacheMap.get(cwd);
    if (cached && cached.generation === storeGeneration)
        return cached.index;
    const index = buildIndex(store);
    // LRU eviction
    if (indexCacheMap.size >= MAX_CACHED_PROJECTS) {
        const oldest = indexCacheMap.keys().next().value;
        if (oldest)
            indexCacheMap.delete(oldest);
    }
    indexCacheMap.set(cwd, { index, generation: storeGeneration });
    return index;
}
function invalidateIndex(cwd) {
    storeGeneration++;
    if (cwd) {
        indexCacheMap.delete(cwd);
    }
    else {
        indexCacheMap.clear();
    }
}
function addToIndex(cwd, entry) {
    const cached = indexCacheMap.get(cwd);
    if (!cached)
        return; // No cache to update; lazy rebuild on next getIndex
    for (const kw of entry.keywords) {
        if (!cached.index.has(kw))
            cached.index.set(kw, new Set());
        cached.index.get(kw).add(entry.id);
    }
    cached.generation = ++storeGeneration;
    indexCacheMap.set(cwd, cached);
}
function removeFromIndex(cwd, entryId) {
    const cached = indexCacheMap.get(cwd);
    if (!cached)
        return;
    for (const [, idSet] of cached.index) {
        idSet.delete(entryId);
    }
    cached.generation = ++storeGeneration;
}
const WAL_COMPACT_LINES = 50;
const WAL_COMPACT_BYTES = 100 * 1024; // 100 KB
let storeCache = null;
function appendWal(cwd, mutation) {
    const p = walPath(cwd);
    const dir = dirname(p);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(p, JSON.stringify(mutation) + "\n", { mode: 0o600 });
    // Invalidate store cache so next loadStore re-reads
    storeCache = null;
}
function readWal(cwd) {
    const p = walPath(cwd);
    if (!existsSync(p))
        return [];
    try {
        const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
        const mutations = [];
        for (const line of lines) {
            try {
                mutations.push(JSON.parse(line));
            }
            catch { /* skip corrupt lines */ }
        }
        return mutations;
    }
    catch {
        return [];
    }
}
function replayWal(store, mutations) {
    for (const m of mutations) {
        const entry = store.entries.find((e) => e.id === m.entryId);
        if (!entry && m.op !== "remember")
            continue;
        switch (m.op) {
            case "increment_recalled":
                if (entry)
                    entry.timesRecalled = (entry.timesRecalled ?? 0) + 1;
                break;
            case "increment_used":
                if (entry)
                    entry.timesUsed = (entry.timesUsed ?? 0) + 1;
                break;
            case "archive":
                if (entry)
                    entry.archived = true;
                break;
            case "update":
                if (entry && m.data)
                    Object.assign(entry, m.data);
                break;
            case "remember":
                if (!entry && m.data) {
                    store.entries.push(m.data);
                }
                break;
        }
    }
}
function compactIfNeeded(cwd) {
    const p = walPath(cwd);
    if (!existsSync(p))
        return false;
    try {
        const stat = statSync(p);
        const lineCount = readFileSync(p, "utf-8").split("\n").filter(Boolean).length;
        if (lineCount >= WAL_COMPACT_LINES || stat.size >= WAL_COMPACT_BYTES) {
            compactNow(cwd);
            return true;
        }
    }
    catch { /* ignore */ }
    return false;
}
function compactNow(cwd) {
    const store = loadStoreBase(cwd);
    const mutations = readWal(cwd);
    replayWal(store, mutations);
    atomicWrite(memoryPath(cwd), JSON.stringify(store, null, 2));
    try {
        unlinkSync(walPath(cwd));
    }
    catch { /* ignore */ }
    storeCache = null;
    invalidateIndex(); // Full invalidation on compaction
}
// ━━━ Git helpers ━━━
function getGitSha(cwd) {
    try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 3000, stdio: "pipe" })
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
        const result = execFileSync("git", ["log", "--format=", "--name-only", `${baseSha}..HEAD`, "--", ...files], { cwd, timeout: 5000, stdio: "pipe" }).toString();
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
const stalenessCache = new Map();
const STALENESS_TTL_MS = 5 * 60 * 1000; // 5 minutes
function checkStaleness(cwd, entry) {
    const cacheKey = `${entry.id}:${entry.gitSha ?? "none"}`;
    const cached = stalenessCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt)
        return cached.result;
    if (!entry.gitSha || !isValidSha(entry.gitSha)) {
        // No git SHA means we can't track staleness — treat as potentially stale
        // Entries without tracked files are low-quality and should be deprioritized
        if (entry.files.length === 0) {
            return { stale: true, reason: "No files tracked — cannot verify if fix is still valid", commitsBehind: 0, filesChanged: [] };
        }
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
    if (changed.length === 0) {
        const result = { stale: false, reason: null, commitsBehind: 0, filesChanged: [] };
        stalenessCache.set(cacheKey, { result, expiresAt: Date.now() + STALENESS_TTL_MS });
        return result;
    }
    const result = {
        stale: true,
        reason: `${changed.length} file(s) changed in ${totalCommits} commit(s) since this diagnosis`,
        commitsBehind: totalCommits,
        filesChanged: changed,
    };
    stalenessCache.set(cacheKey, { result, expiresAt: Date.now() + STALENESS_TTL_MS });
    return result;
}
// ━━━ Pattern Detection Cache ━━━
let patternCache = null;
/**
 * Detect patterns across all stored debug sessions.
 * Cheap — just scans the JSON array, no external calls.
 */
export function detectPatterns(cwd) {
    if (patternCache && patternCache.cwd === cwd && patternCache.generation === storeGeneration) {
        return patternCache.patterns;
    }
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
    patternCache = { cwd, generation: storeGeneration, patterns: insights };
    return insights;
}
// ━━━ Paths & Persistence ━━━
function loadStoreBase(cwd) {
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
export function loadStore(cwd) {
    const p = memoryPath(cwd);
    // Check cache: same cwd and file hasn't changed
    if (storeCache && storeCache.cwd === cwd) {
        try {
            const currentMtime = existsSync(p) ? statSync(p).mtimeMs : 0;
            if (currentMtime === storeCache.mtime)
                return storeCache.store;
        }
        catch { /* fall through to fresh load */ }
    }
    const store = loadStoreBase(cwd);
    const mutations = readWal(cwd);
    replayWal(store, mutations);
    try {
        const mtime = existsSync(p) ? statSync(p).mtimeMs : 0;
        storeCache = { cwd, store, mtime };
    }
    catch { /* cache miss is fine */ }
    return store;
}
export function saveStore(cwd, store) {
    atomicWrite(memoryPath(cwd), JSON.stringify(store, null, 2));
    storeCache = null;
    storeGeneration++; // Invalidate index generation but don't clear cache
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
    // Compute normalized error signature for cross-session deduplication
    const errorSignature = signatureFromError(entry.problem, entry.files[0] ?? null);
    const full = {
        ...entry,
        keywords,
        gitSha: getGitSha(cwd),
        errorSignature,
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
    addToIndex(cwd, full);
    return full;
}
/**
 * Mark memory entries as "used" — the recalled fix was actually applied.
 * Closes the feedback loop: timesUsed feeds into confidence scoring.
 */
export function markUsed(cwd, entryIds) {
    const store = loadStore(cwd);
    for (const id of entryIds) {
        const entry = store.entries.find((e) => e.id === id);
        if (entry) {
            entry.timesUsed = (entry.timesUsed ?? 0) + 1;
            appendWal(cwd, {
                op: "increment_used",
                entryId: id,
                ts: new Date().toISOString(),
            });
        }
    }
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
    // Compute query signature for direct matching (primary key)
    const querySig = signatureFromError(query, null);
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
    // Also include signature matches that keyword search may have missed
    for (const e of store.entries) {
        if (!e.archived && e.errorSignature === querySig && !hitCounts.has(e.id)) {
            hitCounts.set(e.id, queryTokens.length); // full relevance for signature match
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
        // Signature match gets a 2x relevance boost
        const sigBoost = entry.errorSignature === querySig ? 2.0 : 1.0;
        const relevance = (hits / queryTokens.length) * sigBoost;
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
        .filter((e) => e.relevance > 0.4 && !(e.staleness.stale && e.confidence < 0.3))
        .sort((a, b) => {
        // Sort by combined confidence * relevance score
        return (b.confidence * b.relevance) - (a.confidence * a.relevance);
    })
        .slice(0, limit);
    // Append recall increments to WAL instead of full store rewrite
    if (results.length > 0) {
        const resultIds = new Set(results.map((r) => r.id));
        for (const entry of store.entries) {
            if (resultIds.has(entry.id)) {
                entry.timesRecalled = (entry.timesRecalled ?? 0) + 1;
                appendWal(cwd, { op: "increment_recalled", entryId: entry.id, ts: new Date().toISOString() });
            }
        }
        compactIfNeeded(cwd);
    }
    return results;
}
/**
 * Archive memories with confidence below threshold for 30+ days.
 * Archived memories are excluded from auto-recall.
 */
export function archiveStaleMemories(cwd) {
    const store = loadStore(cwd);
    const alreadyArchived = new Set(store.entries.filter(e => e.archived).map(e => e.id));
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
    if (archived > 0) {
        for (const entry of store.entries) {
            if (entry.archived && !alreadyArchived.has(entry.id)) {
                appendWal(cwd, { op: "archive", entryId: entry.id, ts: new Date().toISOString() });
            }
        }
        compactIfNeeded(cwd);
    }
    return { archived };
}
// ━━━ Physical Purge ━━━
export function purgeArchivedEntries(cwd) {
    const store = loadStore(cwd);
    const toArchive = store.entries.filter((e) => e.archived);
    if (toArchive.length === 0)
        return { purged: 0 };
    // Group by month
    const byMonth = new Map();
    for (const entry of toArchive) {
        const month = entry.timestamp.slice(0, 7); // YYYY-MM
        if (!byMonth.has(month))
            byMonth.set(month, []);
        byMonth.get(month).push(entry);
    }
    // Write to archive files
    const archDir = archiveDirPath(cwd);
    if (!existsSync(archDir))
        mkdirSync(archDir, { recursive: true, mode: 0o700 });
    for (const [month, entries] of byMonth) {
        const archFile = join(archDir, `${month}.json`);
        let existing = { version: 1, entries: [] };
        if (existsSync(archFile)) {
            try {
                existing = JSON.parse(readFileSync(archFile, "utf-8"));
            }
            catch { /* start fresh */ }
        }
        const existingIds = new Set(existing.entries.map((e) => e.id));
        for (const e of entries) {
            if (!existingIds.has(e.id))
                existing.entries.push(e);
        }
        atomicWrite(archFile, JSON.stringify(existing, null, 2));
    }
    // Remove archived entries from main store
    store.entries = store.entries.filter((e) => !e.archived);
    saveStore(cwd, store);
    return { purged: toArchive.length };
}
// ━━━ Deferred Archival ━━━
let lastArchivalRun = 0;
export function maybeArchive(cwd) {
    if (Date.now() - lastArchivalRun < 60 * 60 * 1000)
        return { archived: 0, purged: 0 };
    lastArchivalRun = Date.now();
    const archResult = archiveStaleMemories(cwd);
    const purgeResult = purgeArchivedEntries(cwd);
    return { archived: archResult.archived, purged: purgeResult.purged };
}
/**
 * Get memory stats.
 */
export function memoryStats(cwd) {
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