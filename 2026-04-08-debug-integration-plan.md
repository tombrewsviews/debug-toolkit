# Debug Framework Integration Plan

**Date**: 2026-04-08
**Context**: Infinite render loop in monitor dashboard took ~45 minutes to diagnose. The agent manually added console.log, deployed 4 times, built an on-screen debug overlay, and asked the user to read the browser console. The stackpack-debug toolkit (11 tools, 3 resources) was installed but completely unconfigured — none of its capabilities were available.

---

## What Went Wrong

### The Debugging Session (Timeline)

1. User reports: "app stuck at spinner"
2. Agent reads App.tsx, traces render logic, hypothesizes caching issue
3. Agent adds `Cache-Control: no-store` to index.html — **wrong diagnosis, didn't help**
4. Agent adds auth timeout — **didn't help**
5. Agent adds console.log to 4 files, deploys — **user can't share console**
6. Agent tries Ghost OS for screenshots — **no screen recording permission**
7. Agent builds on-screen debug overlay (DebugOverlay component), deploys — **still no runtime visibility**
8. User shares screenshot of console — **infinite loop identified in 5 seconds**
9. Fix: remove the spinner gate — **1-line change**

### Root Cause of Slow Diagnosis

The agent had **zero runtime observability**. It was debugging a production React app by reading source code — equivalent to diagnosing a car engine problem by reading the manual without opening the hood.

With stackpack-debug configured:
- `debug://status` would have shown the infinite re-render loop in seconds (terminal + browser capture)
- `debug_investigate` would have triaged the error and shown the source code window around the crash
- `debug_capture` would have captured the browser console without needing the user to screenshot it
- `debug_verify` would have confirmed the fix before deploying
- `debug_recall` would have checked cross-session memory for similar render loop bugs

**Total time with debug toolkit: ~5 minutes instead of ~45 minutes.**

---

## What Prevented Autonomous Debugging

| Blocker | Why It Mattered |
|---------|----------------|
| **No MCP registration** | `debug_investigate`, `debug_capture`, `debug://status` — none available as tools |
| **No serve mode running** | No live terminal/browser capture — toolkit had nothing to observe |
| **No .claude/rules** | Agent didn't know the toolkit existed or when to activate it |
| **No SKILL.md exposure** | Agent's skill system never triggered the debug workflow |
| **Monitor is Express + Vite** | Needs `spdg serve -- npm run dev:client` to capture browser console |
| **Production-only bug** | Local dev server wasn't running — debug toolkit needs a running process to observe |

---

## Improvement Plan

### Phase 1: Make stackpack-debug available to agents (immediate) -- DONE

**The fix was one command:**

```bash
cd /Users/parandykt/Apps/stackpack && spdg init
```

This automatically:
- Registered MCP server in `.mcp.json` (auto-starts with Claude Code)
- Added activation rules to `.claude/rules/stackpack-debug.md`
- Installed SKILL.md to `.claude/skills/stackpack-debug/SKILL.md`
- Added `/debug-all` command to `.claude/commands/debug-all.md`

The published npm package (`stackpack-debug@0.18.0`) handles its own setup. No manual config needed.

**Lesson: The agent should have checked for `spdg init` or `npx stackpack-debug init` as a first step instead of planning manual configuration.**

### Phase 2: Enable live capture for monitor (this week)

**2.1 Add `dev:debug` script to monitor/package.json**

```json
"dev:debug": "spdg serve -- npm run dev"
```

This wraps the dev server with the debug proxy, capturing:
- Terminal output (Vite build errors, TypeScript errors)
- Browser console (via injected script)
- Network failures (fetch/XHR)

**2.2 Create monitor/.debug/config.json**

```json
{
  "captureVisual": true,
  "ghostOsIntegration": true,
  "proxyPort": 3080,
  "targetPort": 3002
}
```

**2.3 Add Vite plugin for client-side capture**

In `monitor/vite.config.ts`:
```typescript
import debugToolkit from 'stackpack-debug/vite-plugin';
// Add to plugins array
```

This injects browser console capture without needing the proxy.

### Phase 3: Production observability (next)

**3.1 The production gap**

The infinite loop bug was **production-only** — it only manifested after deploying to Fly. Local dev wouldn't reproduce it because the code paths differ.

For production debugging, stackpack-debug needs:
- A way to read Fly machine logs (`flyctl logs`)
- A way to capture browser console from the deployed app (not just local dev)

**3.2 Add `debug_fly_logs` integration**

New capability: when debugging a deployed StackPack app, automatically pull recent logs from Fly:
```
flyctl logs --app stackpack-monitor --no-tail | tail -100
```

This already exists as the `logs` MCP tool in ship — but stackpack-debug doesn't know about it. The debug toolkit should check if the project is deployed on Fly and offer to pull logs.

**3.3 Add client-side error reporting**

For production browser errors, add a lightweight error reporter to the monitor client:
- Captures unhandled errors + rejections
- POSTs to `/api/debug/errors` (new endpoint)
- Stores in a ring buffer (last 50 errors)
- `debug://status` reads from this endpoint when checking deployed apps

### Phase 4: Cross-session learning (ongoing)

**4.1 Save this debugging session as memory**

The infinite loop diagnosis should be saved to `.debug/memory/` so future agents can recall it:
```json
{
  "errorType": "infinite-render-loop",
  "affectedFile": "monitor/client/src/App.tsx",
  "rootCause": "Conditional render gate that unmounts a component which sets the gate's dependency on mount",
  "fix": "Remove render gates that depend on state set by the gated component",
  "pattern": "Component A checks state X → shows Component B → Component B sets state X → Component A re-renders → unmounts B → B remounts → sets X again",
  "confidence": 100
}
```

**4.2 Pattern detection**

This bug is a common React anti-pattern. `debug_patterns` should flag:
- "Conditional render that depends on state modified by the conditionally-rendered component"
- This pattern appears whenever a parent's render gate depends on state that a child sets on mount

---

## Metrics

| Metric | Before | Target |
|--------|--------|--------|
| Time to diagnose production UI bug | ~45 min | <10 min |
| Deploys needed for debugging | 4 | 0-1 |
| Manual console.log additions | 15+ lines across 4 files | 0 |
| User intervention needed | 3 times (screenshot, grant permissions, paste console) | 0 |
| Lines of throwaway debug code written | ~80 (overlay, error boundary, logging) | 0 |

---

## Summary

The stackpack-debug toolkit is mature and powerful — 11 tools, 3 resources, cross-session memory, visual debugging, performance profiling. But it was completely invisible to the agent because:

1. **Not registered as MCP server** — tools weren't available
2. **No activation rules** — agent didn't know when to use it
3. **No serve mode** — nothing to observe
4. **No production bridge** — can't debug deployed apps

The fix is configuration, not code. Phase 1 (MCP registration + rules) takes 10 minutes and would have saved 40 minutes of debugging today.
