/**
 * packs.ts — Exportable knowledge packs.
 *
 * Export project debug knowledge as shareable JSON packs.
 * Import external packs into a project's memory.
 */
export interface KnowledgePack {
    version: "1.0";
    name: string;
    description: string;
    exportedAt: string;
    entries: PackEntry[];
}
export interface PackEntry {
    errorType: string;
    category: string;
    problem: string;
    diagnosis: string;
    files: string[];
    rootCause: {
        trigger: string;
        errorFile: string;
        causeFile: string;
        fixDescription: string;
    } | null;
}
export declare function exportPack(cwd: string, outPath: string, options?: {
    name?: string;
    filter?: string;
    includeArchived?: boolean;
}): {
    path: string;
    entries: number;
};
export declare function importPack(cwd: string, packPath: string): {
    imported: number;
    total: number;
};
