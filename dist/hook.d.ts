/**
 * Install the pre-commit hook into the nearest .git directory.
 * If a pre-commit hook already exists, appends our check.
 * If our check is already present, does nothing.
 */
export declare function installHook(cwd: string): {
    installed: boolean;
    path: string | null;
    message: string;
};
/**
 * Remove our hook content from the pre-commit hook.
 */
export declare function uninstallHook(cwd: string): {
    removed: boolean;
    message: string;
};
