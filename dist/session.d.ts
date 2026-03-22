export interface Hypothesis {
    id: string;
    text: string;
    status: "testing" | "confirmed" | "rejected";
    evidence: string[];
}
export interface InstrumentationRecord {
    id: string;
    filePath: string;
    lineNumber: number;
    markerTag: string;
    language: string;
    insertedCode: string;
    active: boolean;
    hypothesisId: string | null;
}
export interface Capture {
    id: string;
    timestamp: string;
    source: "terminal" | "browser-console" | "browser-network" | "browser-error" | "environment" | "tauri-log";
    markerTag: string | null;
    data: unknown;
    hypothesisId: string | null;
}
export interface FileSnapshot {
    filePath: string;
    content: string;
    takenAt: string;
}
export interface DebugSession {
    id: string;
    version: number;
    createdAt: string;
    status: "active" | "resolved" | "abandoned";
    problem: string;
    hypotheses: Hypothesis[];
    instrumentation: InstrumentationRecord[];
    captures: Capture[];
    snapshots: Record<string, FileSnapshot>;
    diagnosis: string | null;
    _markerIndex: Record<string, string>;
}
export declare const MAX_FILE_SIZE: number;
export declare function createSession(cwd: string, problem: string): DebugSession;
export declare function saveSession(cwd: string, session: DebugSession): void;
export declare function loadSession(cwd: string, sessionId: string): DebugSession;
export declare function indexMarker(session: DebugSession, tag: string, hypothesisId: string | null): void;
export declare function lookupHypothesis(session: DebugSession, markerTag: string): string | null;
export declare function newHypothesisId(): string;
export declare function newInstrumentationId(): string;
export declare function newCaptureId(): string;
export declare function nextMarkerTag(): string;
export declare function resetMarkerCounter(): void;
