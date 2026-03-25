import { type DebugSession, type InstrumentationRecord } from "./session.js";
export interface InstrumentOptions {
    cwd: string;
    session: DebugSession;
    filePath: string;
    lineNumber: number;
    expression: string;
    hypothesisId?: string;
    condition?: string;
}
export interface InstrumentResult {
    record: InstrumentationRecord;
    markerTag: string;
    insertedCode: string;
}
export declare function instrumentFile(opts: InstrumentOptions): InstrumentResult;
