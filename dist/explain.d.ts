/**
 * explain.ts — Decision explainability for stackpack-debug.
 *
 * Generates human-readable explanations for:
 * - Why triage classified an error at a given complexity level
 * - Why confidence scored a memory entry high/low
 * - Why a suggestion was or wasn't generated
 * - Why a memory entry was archived
 */
import { type ConfidenceFactors } from "./confidence.js";
export interface TriageExplanation {
    level: string;
    reasons: string[];
    skipped: string[];
    timeEstimate: string;
}
export declare function explainTriage(level: "trivial" | "medium" | "complex", errorType: string, userFrames: number, isTrivialPattern: boolean): TriageExplanation;
export interface ConfidenceExplanation {
    score: number;
    scoreLabel: string;
    factors: {
        name: string;
        value: number;
        weight: number;
        contribution: number;
        interpretation: string;
    }[];
    recommendation: string;
}
export declare function explainConfidence(factors: ConfidenceFactors): ConfidenceExplanation;
export interface ArchivalExplanation {
    archived: boolean;
    reason: string;
    factors: {
        confidence: number;
        ageInDays: number;
        threshold: number;
    };
}
export declare function explainArchival(confidence: number, ageInDays: number): ArchivalExplanation;
