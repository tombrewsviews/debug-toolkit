import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
const HOOK_MARKER_START = "# >>> stackpack-debug pre-commit check";
const HOOK_MARKER_END = "# <<< stackpack-debug pre-commit check";
const HOOK_CONTENT = `
${HOOK_MARKER_START}
# Block commits containing stackpack-debug instrumentation markers
if git diff --cached --name-only | xargs grep -l "__DBG_START_" 2>/dev/null | grep -v node_modules | grep -v .debug; then
  echo ""
  echo "\\033[31mERROR: stackpack-debug instrumentation markers found in staged files.\\033[0m"
  echo "Run 'npx stackpack-debug clean' to remove them before committing."
  echo ""
  exit 1
fi
${HOOK_MARKER_END}
`;
/**
 * Install the pre-commit hook into the nearest .git directory.
 * If a pre-commit hook already exists, appends our check.
 * If our check is already present, does nothing.
 */
export function installHook(cwd) {
    // Find .git directory
    let dir = cwd;
    let gitDir = null;
    while (true) {
        const candidate = join(dir, ".git");
        if (existsSync(candidate)) {
            gitDir = candidate;
            break;
        }
        const parent = dirname(dir);
        if (parent === dir)
            break; // filesystem root reached
        dir = parent;
    }
    if (!gitDir) {
        return {
            installed: false,
            path: null,
            message: "No .git directory found. Pre-commit hook not installed.",
        };
    }
    const hooksDir = join(gitDir, "hooks");
    if (!existsSync(hooksDir)) {
        mkdirSync(hooksDir, { recursive: true });
    }
    const hookPath = join(hooksDir, "pre-commit");
    if (existsSync(hookPath)) {
        const existing = readFileSync(hookPath, "utf-8");
        if (existing.includes(HOOK_MARKER_START)) {
            return {
                installed: true,
                path: hookPath,
                message: "Pre-commit hook already installed.",
            };
        }
        // Append to existing hook
        writeFileSync(hookPath, existing + "\n" + HOOK_CONTENT);
    }
    else {
        // Create new hook
        writeFileSync(hookPath, "#!/bin/sh\n" + HOOK_CONTENT);
    }
    chmodSync(hookPath, 0o755);
    return {
        installed: true,
        path: hookPath,
        message: `Pre-commit hook installed at ${hookPath}`,
    };
}
/**
 * Remove our hook content from the pre-commit hook.
 */
export function uninstallHook(cwd) {
    let dir = cwd;
    let gitDir = null;
    while (true) {
        const candidate = join(dir, ".git");
        if (existsSync(candidate)) {
            gitDir = candidate;
            break;
        }
        const parent = dirname(dir);
        if (parent === dir)
            break; // filesystem root reached
        dir = parent;
    }
    if (!gitDir) {
        return { removed: false, message: "No .git directory found." };
    }
    const hookPath = join(gitDir, "hooks", "pre-commit");
    if (!existsSync(hookPath)) {
        return { removed: false, message: "No pre-commit hook found." };
    }
    const content = readFileSync(hookPath, "utf-8");
    if (!content.includes(HOOK_MARKER_START)) {
        return { removed: false, message: "stackpack-debug hook not found in pre-commit." };
    }
    // Remove our section
    const regex = new RegExp(`\\n?${HOOK_MARKER_START}[\\s\\S]*?${HOOK_MARKER_END}\\n?`, "g");
    const cleaned = content.replace(regex, "").trim();
    if (cleaned === "#!/bin/sh" || cleaned === "") {
        // Hook is empty after removing our section — delete it
        unlinkSync(hookPath);
    }
    else {
        writeFileSync(hookPath, cleaned + "\n");
    }
    return { removed: true, message: "Pre-commit hook removed." };
}
//# sourceMappingURL=hook.js.map