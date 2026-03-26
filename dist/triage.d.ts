/**
 * triage.ts — Error complexity classification.
 *
 * Classifies errors as trivial/medium/complex to determine
 * how much of the investigation pipeline to run.
 *
 * Trivial: self-explanatory, single file, known pattern → fast-path
 * Medium: known type, needs some context → partial pipeline
 * Complex: ambiguous, multi-file, no pattern → full pipeline
 */
import { type ErrorClassification } from "./context.js";
export interface TriageResult {
    level: "trivial" | "medium" | "complex";
    skipFullPipeline: boolean;
    skipEnvScan: boolean;
    skipMemorySearch: boolean;
    fixHint: string | null;
    classification: ErrorClassification;
}
export declare function triageError(errorText: string): TriageResult;
