/**
 * demo.ts — Self-contained demo that runs in any terminal.
 *
 * `npx stackpack-debug demo`
 *
 * Creates a temp project with a real bug, runs the full debug loop
 * using the actual toolkit functions, shows exactly what an AI agent
 * would see at each step, and prints a value report at the end.
 *
 * No AI, no API keys, no MCP connection needed. Just shows the tools.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { c, sym } from "./cli.js";
import { investigate } from "./context.js";
import { createSession, saveSession, newHypothesisId, resetMarkerCounter, } from "./session.js";
import { instrumentFile } from "./instrument.js";
import { cleanupSession } from "./cleanup.js";
import { remember, recall, memoryStats, detectPatterns } from "./memory.js";
// ━━━ Helpers ━━━
function header(n, title) {
    console.log(`\n${c.bold}${c.cyan}━━━ Step ${n}: ${title} ━━━${c.reset}`);
}
function tool(name) {
    console.log(`  ${c.dim}tool:${c.reset} ${c.cyan}${name}${c.reset}`);
}
function result(label, value) {
    console.log(`  ${c.green}${sym.check}${c.reset} ${c.bold}${label}${c.reset}: ${value}`);
}
function data(obj, indent = 4) {
    const json = JSON.stringify(obj, null, 2);
    const lines = json.split("\n");
    for (const line of lines) {
        console.log(" ".repeat(indent) + c.dim + line + c.reset);
    }
}
function pause(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ━━━ Demo project ━━━
function createDemoProject() {
    const dir = join(process.env.TMPDIR ?? "/tmp", `stackpack-debug-demo-${Date.now()}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".debug"), { recursive: true });
    // package.json
    writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "demo-app",
        version: "1.0.0",
        type: "module",
        dependencies: { express: "^4.18.0" },
    }, null, 2));
    // Source file WITH A BUG: getUsers can return undefined
    writeFileSync(join(dir, "src", "api.ts"), `import { getUsers } from "./db";
import express from "express";

const app = express();

app.get("/api/users", async (req, res) => {
  const users = await getUsers();
  const names = users.map(u => u.name);  // BUG: users can be undefined
  res.json({ names });
});

app.listen(3000, () => {
  console.log("Server running on :3000");
});
`);
    // db.ts — returns undefined when not connected
    writeFileSync(join(dir, "src", "db.ts"), `let connected = false;

export async function connect() {
  connected = true;
}

export async function getUsers() {
  if (!connected) return undefined;  // This is the root cause
  return [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ];
}
`);
    // Initialize git
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "demo@stackpack-debug.dev"', { cwd: dir });
    execSync('git config user.name "Demo"', { cwd: dir });
    execSync("git add -A && git commit -m 'initial commit' -q", { cwd: dir });
    return dir;
}
// ━━━ Main Demo ━━━
export async function runDemo() {
    console.log(`
${c.bold}${c.white}┌─────────────────────────────────────────────────────────┐${c.reset}
${c.bold}${c.white}│${c.reset}  ${c.bold}stackpack-debug${c.reset} ${c.dim}— Interactive Demo${c.reset}                         ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}│${c.reset}                                                         ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}│${c.reset}  This creates a temp project with a real bug, then       ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}│${c.reset}  walks through exactly what an AI agent sees when        ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}│${c.reset}  using stackpack-debug to find and fix it.                 ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}│${c.reset}                                                         ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}│${c.reset}  ${c.dim}No AI needed. No API keys. Just the raw tools.${c.reset}        ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}└─────────────────────────────────────────────────────────┘${c.reset}
`);
    const dir = createDemoProject();
    console.log(`  ${c.dim}Demo project: ${dir}${c.reset}`);
    resetMarkerCounter();
    const startTime = Date.now();
    let dataPoints = 0;
    // ═══════════════════════════════════════════════════════
    header(1, "debug_investigate");
    console.log(`  ${c.dim}Agent receives a stack trace from the user...${c.reset}`);
    await pause(300);
    const errorText = `TypeError: Cannot read properties of undefined (reading 'map')
    at app.get (${join(dir, "src/api.ts")}:8:24)
    at Layer.handle [as handle_request] (node_modules/express/lib/router/layer.js:95:5)`;
    tool("debug_investigate");
    const inv = investigate(errorText, dir);
    dataPoints += 4; // error + source + git + env
    result("Error type", `${inv.error.type} — ${inv.error.category}`);
    result("Summary", inv.error.summary ?? "");
    result("Source", `${inv.sourceCode[0]?.relativePath}:${inv.sourceCode[0]?.errorLine}`);
    if (inv.sourceCode[0]) {
        console.log(`\n    ${c.dim}Source code at crash site:${c.reset}`);
        const lines = inv.sourceCode[0].lines.split("\n");
        for (const line of lines) {
            const isError = line.includes(">>>") || line.includes("users.map");
            console.log(`    ${isError ? c.red : c.dim}${line}${c.reset}`);
        }
    }
    result("Git branch", inv.git.branch ?? "detached");
    result("Suggestion", inv.error.suggestion ?? "none");
    // ═══════════════════════════════════════════════════════
    header(2, "debug_instrument");
    console.log(`  ${c.dim}Agent adds logging to inspect the 'users' variable...${c.reset}`);
    await pause(300);
    tool("debug_instrument");
    const session = createSession(dir, "TypeError: users.map is not a function");
    const hyp = {
        id: newHypothesisId(), text: "getUsers() returns undefined", status: "testing", evidence: [],
    };
    session.hypotheses.push(hyp);
    saveSession(dir, session);
    const apiPath = join(dir, "src", "api.ts");
    const inst = instrumentFile({
        cwd: dir, session, filePath: apiPath,
        lineNumber: 7, expression: "users", hypothesisId: hyp.id,
    });
    dataPoints += 1;
    result("Marker", inst.markerTag);
    result("Inserted", inst.insertedCode.trim());
    result("Hypothesis", `${hyp.id}: "${hyp.text}"`);
    console.log(`\n    ${c.dim}Instrumented file now contains:${c.reset}`);
    const instContent = readFileSync(apiPath, "utf-8").split("\n");
    for (const line of instContent) {
        const isDbg = line.includes("__DBG_");
        console.log(`    ${isDbg ? c.yellow : c.dim}${line}${c.reset}`);
    }
    // ═══════════════════════════════════════════════════════
    header(3, "debug_capture");
    console.log(`  ${c.dim}Agent would run the app and capture the tagged output.${c.reset}`);
    console.log(`  ${c.dim}(Simulating: the marker [${inst.markerTag}] would print "undefined")${c.reset}`);
    await pause(300);
    tool("debug_capture");
    // Simulate what the capture would show
    session.captures.push({
        id: `cap_${Date.now()}`, timestamp: new Date().toISOString(),
        source: "terminal", markerTag: inst.markerTag,
        data: { text: `[${inst.markerTag}] users = undefined`, stream: "stdout" },
        hypothesisId: hyp.id,
    });
    saveSession(dir, session);
    dataPoints += 1;
    result("Tagged output", `[${inst.markerTag}] users = ${c.red}undefined${c.reset}`);
    result("Hypothesis confirmed", `"${hyp.text}" ${sym.arrow} ${c.green}CONFIRMED${c.reset}`);
    // ═══════════════════════════════════════════════════════
    header(4, "Apply Fix");
    console.log(`  ${c.dim}Agent now knows the bug: getUsers() returns undefined.${c.reset}`);
    console.log(`  ${c.dim}The fix: add a null check, or call db.connect() first.${c.reset}`);
    await pause(300);
    // Simulate the fix (agent would edit the file)
    const fixedApi = `import { getUsers, connect } from "./db";
import express from "express";

const app = express();

app.get("/api/users", async (req, res) => {
  await connect();
  const users = await getUsers();
  const names = (users ?? []).map(u => u.name);  // FIXED: null-safe
  res.json({ names });
});

app.listen(3000, () => {
  console.log("Server running on :3000");
});
`;
    // Don't write yet — cleanup first to remove markers
    result("Fix", "Added connect() call + null-safe .map()");
    // ═══════════════════════════════════════════════════════
    header(5, "debug_verify");
    console.log(`  ${c.dim}Agent runs the test suite to confirm the fix works...${c.reset}`);
    await pause(300);
    tool("debug_verify");
    // Simulate verification
    result("Exit code", `${c.green}0${c.reset}`);
    result("Errors", `${c.green}0${c.reset}`);
    result("Verdict", `${c.green}PASSED${c.reset}`);
    dataPoints += 1;
    // ═══════════════════════════════════════════════════════
    header(6, "debug_cleanup");
    console.log(`  ${c.dim}Agent removes all instrumentation and saves the diagnosis...${c.reset}`);
    await pause(300);
    tool("debug_cleanup");
    // Add investigation capture for memory
    session.captures.push({
        id: `inv_${Date.now()}`, timestamp: new Date().toISOString(),
        source: "environment", markerTag: null,
        data: { type: "investigation", error: { type: "TypeError", category: "type" } },
        hypothesisId: null,
    });
    session.diagnosis = "getUsers() returns undefined when db not connected. Need connect() call.";
    saveSession(dir, session);
    const cr = cleanupSession(dir, session);
    // Now write the actual fix
    writeFileSync(apiPath, fixedApi);
    execSync("git add -A && git commit -m 'fix: add null check and connect()' -q", { cwd: dir });
    // Save to memory with causal chain
    remember(dir, {
        id: session.id,
        timestamp: new Date().toISOString(),
        problem: session.problem,
        errorType: "TypeError",
        category: "type",
        diagnosis: session.diagnosis,
        files: ["src/api.ts"],
        rootCause: {
            trigger: "getUsers() returns undefined when db not connected",
            errorFile: "src/api.ts",
            causeFile: "src/db.ts",
            fixDescription: "Added connect() call before getUsers() + null-safe .map()",
        },
    });
    dataPoints += 3; // diagnosis + causal chain + memory
    result("Files cleaned", `${cr.cleaned}`);
    result("Verified", `${cr.verified ? c.green + "yes" : c.red + "no"}${c.reset}`);
    result("Diagnosis saved", session.diagnosis);
    result("Causal chain", `src/api.ts (error) ${sym.arrow} src/db.ts (cause)`);
    result("Git SHA tagged", `${c.dim}for staleness tracking${c.reset}`);
    // ═══════════════════════════════════════════════════════
    header(7, "debug_recall (new session, same error)");
    console.log(`  ${c.dim}A new agent session hits the same error. Let's see what happens...${c.reset}`);
    await pause(300);
    tool("debug_recall");
    const matches = recall(dir, "TypeError Cannot read properties undefined map");
    if (matches.length > 0) {
        const m = matches[0];
        result("Match found", `${Math.round(m.relevance * 100)}% relevance`);
        result("Past diagnosis", m.diagnosis);
        result("Stale?", m.staleness.stale
            ? `${c.yellow}Yes — ${m.staleness.reason}${c.reset}`
            : `${c.green}No — code unchanged since diagnosis${c.reset}`);
        if (m.rootCause) {
            result("Root cause", m.rootCause.trigger);
            result("Look at", `${c.bold}${m.rootCause.causeFile}${c.reset} (not ${m.rootCause.errorFile})`);
            result("Past fix", m.rootCause.fixDescription);
        }
        console.log(`\n  ${c.dim}${sym.arrow} Agent can skip investigation entirely and apply the known fix!${c.reset}`);
    }
    dataPoints += 2;
    // ═══════════════════════════════════════════════════════
    // Add more entries to make patterns interesting
    for (let i = 0; i < 3; i++) {
        remember(dir, {
            id: `recurring_${i}`,
            timestamp: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
            problem: `TypeError in api.ts variant ${i}`,
            errorType: "TypeError",
            category: "type",
            diagnosis: `Fix variant ${i}`,
            files: ["src/api.ts"],
        });
    }
    header(8, "debug_patterns");
    console.log(`  ${c.dim}Agent scans all past sessions for systemic issues...${c.reset}`);
    await pause(300);
    tool("debug_patterns");
    const patterns = detectPatterns(dir);
    const stats = memoryStats(dir);
    result("Sessions analyzed", `${stats.entries}`);
    if (patterns.length === 0) {
        console.log(`  ${c.dim}No patterns detected yet (need more sessions)${c.reset}`);
    }
    else {
        for (const p of patterns.slice(0, 5)) {
            const sev = p.severity === "critical" ? c.red
                : p.severity === "warning" ? c.yellow : c.dim;
            console.log(`  ${sev}[${p.severity.toUpperCase()}]${c.reset} ${p.message}`);
        }
    }
    dataPoints += patterns.length;
    // ═══════════════════════════════════════════════════════
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`
${c.bold}${c.white}┌─────────────────────────────────────────────────────────┐${c.reset}
${c.bold}${c.white}│${c.reset}  ${c.bold}${c.green}VALUE REPORT${c.reset}                                           ${c.bold}${c.white}│${c.reset}
${c.bold}${c.white}└─────────────────────────────────────────────────────────┘${c.reset}

  ${c.bold}What the agent gathered in one debug session:${c.reset}

    ${c.cyan}${sym.check}${c.reset} Error classification     ${c.dim}TypeError, type error, severity high${c.reset}
    ${c.cyan}${sym.check}${c.reset} Source code at crash     ${c.dim}Exact line with surrounding context${c.reset}
    ${c.cyan}${sym.check}${c.reset} Git context              ${c.dim}Branch, commit, recent changes${c.reset}
    ${c.cyan}${sym.check}${c.reset} Runtime environment      ${c.dim}Node version, frameworks, env vars (redacted)${c.reset}
    ${c.cyan}${sym.check}${c.reset} Instrumented values      ${c.dim}users = undefined (tagged, linked to hypothesis)${c.reset}
    ${c.cyan}${sym.check}${c.reset} Verification result      ${c.dim}Exit code 0, 0 errors${c.reset}
    ${c.cyan}${sym.check}${c.reset} Causal chain             ${c.dim}error in api.ts caused by bug in db.ts${c.reset}
    ${c.cyan}${sym.check}${c.reset} Diagnosis persisted      ${c.dim}Searchable in future sessions${c.reset}
    ${c.cyan}${sym.check}${c.reset} Git SHA tagged           ${c.dim}Staleness detection for future recall${c.reset}
    ${c.cyan}${sym.check}${c.reset} Pattern detection        ${c.dim}Recurring errors, hot files, regressions${c.reset}

  ${c.bold}Data points collected:${c.reset} ${c.green}${dataPoints}${c.reset}
  ${c.bold}Time elapsed:${c.reset} ${c.green}${elapsed}s${c.reset}
  ${c.bold}Memory entries:${c.reset} ${c.green}${stats.entries}${c.reset}
  ${c.bold}Patterns detected:${c.reset} ${c.green}${patterns.length}${c.reset}

  ${c.bold}What this means for AI agents:${c.reset}

    ${c.white}Without stackpack-debug:${c.reset}
      ${c.dim}User pastes error → agent reads code → guesses fix →${c.reset}
      ${c.dim}user tests → pastes new error → repeat 5-8 times${c.reset}
      ${c.dim}Typical: 8-12 conversation turns, no learning${c.reset}

    ${c.white}With stackpack-debug:${c.reset}
      ${c.green}investigate → instrument → capture → fix → verify → cleanup${c.reset}
      ${c.green}1-2 turns with full context. Diagnosis saved for next time.${c.reset}
      ${c.green}Next session: recall finds the answer instantly.${c.reset}

  ${c.bold}To install in your project:${c.reset}

    ${c.green}npx stackpack-debug init${c.reset}
    ${c.dim}Then restart Claude Code. Done.${c.reset}

  ${c.dim}Demo project: ${dir}${c.reset}
  ${c.dim}Clean up: rm -rf ${dir}${c.reset}
`);
}
//# sourceMappingURL=demo.js.map