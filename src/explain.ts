/**
 * explain.ts — Decision explainability for debug-toolkit.
 *
 * Generates human-readable explanations for:
 * - Why triage classified an error at a given complexity level
 * - Why confidence scored a memory entry high/low
 * - Why a suggestion was or wasn't generated
 * - Why a memory entry was archived
 */

import { computeConfidence, type ConfidenceFactors } from "./confidence.js";

export interface TriageExplanation {
  level: string;
  reasons: string[];
  skipped: string[];
  timeEstimate: string;
}

export function explainTriage(
  level: "trivial" | "medium" | "complex",
  errorType: string,
  userFrames: number,
  isTrivialPattern: boolean,
): TriageExplanation {
  const reasons: string[] = [];
  const skipped: string[] = [];

  if (level === "trivial") {
    if (isTrivialPattern) reasons.push(`"${errorType}" matches a known trivial pattern`);
    if (userFrames <= 1) reasons.push(`Only ${userFrames} user frame(s) in stack — straightforward origin`);
    skipped.push("Full pipeline", "Environment scan", "Memory search");
    return { level, reasons, skipped, timeEstimate: "<100ms" };
  }

  if (level === "medium") {
    reasons.push(`Known error type "${errorType}" with moderate stack depth (${userFrames} frames)`);
    skipped.push("Environment scan");
    return { level, reasons, skipped, timeEstimate: "~500ms" };
  }

  // complex
  reasons.push(`Error requires full investigation — ${userFrames} user frames detected`);
  if (userFrames >= 5) reasons.push("Deep stack trace suggests cross-module interaction");
  if (!errorType || errorType === "unknown") reasons.push("Unrecognized error type requires broad context gathering");
  return { level, reasons, skipped: [], timeEstimate: "~2s" };
}

export interface ConfidenceExplanation {
  score: number;
  scoreLabel: string;
  factors: { name: string; value: number; weight: number; contribution: number; interpretation: string }[];
  recommendation: string;
}

export function explainConfidence(factors: ConfidenceFactors): ConfidenceExplanation {
  const score = computeConfidence(factors);

  const ageFactor = Math.exp(-Math.LN2 * factors.ageInDays / 90);
  const driftFactor = Math.exp(-Math.LN2 * factors.fileDriftCommits / 50);
  const usageFactor = factors.timesRecalled > 0
    ? Math.min(factors.timesUsed / factors.timesRecalled, 1.0)
    : 0.5;

  const breakdown = [
    {
      name: "Age",
      value: ageFactor,
      weight: 0.3,
      contribution: 0.3 * ageFactor,
      interpretation: factors.ageInDays <= 7
        ? "Very recent — high relevance"
        : factors.ageInDays <= 30
          ? "Recent — still relevant"
          : factors.ageInDays <= 90
            ? "Aging — relevance declining"
            : "Old — likely outdated",
    },
    {
      name: "File Drift",
      value: driftFactor,
      weight: 0.4,
      contribution: 0.4 * driftFactor,
      interpretation: factors.fileDriftCommits <= 5
        ? "Files barely changed — fix likely still valid"
          : factors.fileDriftCommits <= 20
            ? "Moderate changes — fix may need adaptation"
            : "Heavy changes — fix probably outdated",
    },
    {
      name: "Usage",
      value: usageFactor,
      weight: 0.3,
      contribution: 0.3 * usageFactor,
      interpretation: factors.timesRecalled === 0
        ? "Never recalled — no usage signal"
        : factors.timesUsed / factors.timesRecalled > 0.7
          ? "Frequently used when recalled — high quality fix"
          : factors.timesUsed / factors.timesRecalled > 0.3
            ? "Sometimes useful — moderate quality"
            : "Rarely used when recalled — low quality fix",
    },
  ];

  const scoreLabel = score >= 0.8 ? "High" : score >= 0.5 ? "Medium" : score >= 0.3 ? "Low" : "Very Low";
  const recommendation = score >= 0.8
    ? "Proactively suggest this fix when similar errors appear"
    : score >= 0.5
      ? "Include in recall results but let the agent decide"
      : score >= 0.3
        ? "Show only if no better matches exist"
        : "Consider archiving — this fix is likely outdated";

  return { score, scoreLabel, factors: breakdown, recommendation };
}

export interface ArchivalExplanation {
  archived: boolean;
  reason: string;
  factors: { confidence: number; ageInDays: number; threshold: number };
}

export function explainArchival(
  confidence: number,
  ageInDays: number,
): ArchivalExplanation {
  const ARCHIVE_THRESHOLD = 0.2;
  const MIN_AGE = 30;
  const archived = confidence < ARCHIVE_THRESHOLD && ageInDays > MIN_AGE;

  let reason: string;
  if (archived) {
    reason = `Confidence (${(confidence * 100).toFixed(0)}%) is below the ${ARCHIVE_THRESHOLD * 100}% threshold and entry is ${ageInDays} days old (>${MIN_AGE} day minimum). Auto-archived.`;
  } else if (confidence < ARCHIVE_THRESHOLD) {
    reason = `Confidence is low (${(confidence * 100).toFixed(0)}%) but entry is only ${ageInDays} days old — kept until ${MIN_AGE} days.`;
  } else {
    reason = `Confidence (${(confidence * 100).toFixed(0)}%) is above the ${ARCHIVE_THRESHOLD * 100}% threshold — entry is healthy.`;
  }

  return { archived, reason, factors: { confidence, ageInDays, threshold: ARCHIVE_THRESHOLD } };
}
