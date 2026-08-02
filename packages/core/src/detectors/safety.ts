/**
 * SPEC §4 safety detectors: hostility, extortion, scamlink.
 *
 * Extortion is the founder's pet issue (it is on their homepage), so it is
 * modelled properly: three slot families — DEMAND, CONDITIONAL, LEVERAGE —
 * scored by co-occurrence and proximity rather than one brittle regex. That
 * catches the reordered and Hinglish variants a fixed pattern would miss:
 *
 *   "give me a refund or I'll leave a 1 star review"     demand→cond→leverage
 *   "warna main bura review kar dunga, paisa wapas karo"  cond→leverage→demand
 *   "I'll post about this unless you refund"              leverage→cond→demand
 */

import { AhoCorasick, keepLongest } from "./aho.js";
import {
  EXTORTION_CONDITIONAL,
  EXTORTION_DEMAND,
  EXTORTION_LEVERAGE,
  HOSTILITY_SEV1,
  HOSTILITY_SEV2,
  HOSTILITY_SEV3,
  SCAM_PAYMENT,
  SCAM_TOO_GOOD,
  SCAM_URGENCY,
} from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

// --- hostility -------------------------------------------------------------

const hostility = new AhoCorasick();
hostility.addAll(HOSTILITY_SEV1, "1");
hostility.addAll(HOSTILITY_SEV2, "2");
hostility.addAll(HOSTILITY_SEV3, "3");
hostility.build();

export function detectHostility(views: NormalizedViews): Detection[] {
  const matches = keepLongest(hostility.search(views.deleet));

  return matches.map((match) => {
    const severity = Number(match.tag);
    return {
      type: `safety.hostility.sev${severity}`,
      span: { start: match.start, end: match.end },
      confidence: severity === 3 ? 0.95 : severity === 2 ? 0.9 : 0.7,
      evidence: match.term,
    };
  });
}

// --- extortion -------------------------------------------------------------

const extortion = new AhoCorasick();
extortion.addAll(EXTORTION_DEMAND, "demand");
extortion.addAll(EXTORTION_CONDITIONAL, "conditional");
extortion.addAll(EXTORTION_LEVERAGE, "leverage");
extortion.build();

/** Slots must co-occur within this many characters to count as one threat. */
const EXTORTION_WINDOW = 160;

export function detectExtortion(views: NormalizedViews): Detection[] {
  const matches = keepLongest(extortion.search(views.deleet));
  if (matches.length === 0) return [];

  const demand = matches.filter((m) => m.tag === "demand");
  const conditional = matches.filter((m) => m.tag === "conditional");
  const leverage = matches.filter((m) => m.tag === "leverage");

  // Leverage is the necessary ingredient: without a threat to review/report,
  // "refund or else" is an ordinary (if grumpy) service complaint.
  if (leverage.length === 0) return [];
  if (demand.length === 0 && conditional.length === 0) return [];

  const detections: Detection[] = [];

  for (const lev of leverage) {
    const nearDemand = demand.find((d) => distance(d, lev) <= EXTORTION_WINDOW);
    const nearConditional = conditional.find((c) => distance(c, lev) <= EXTORTION_WINDOW);

    // Full pattern: demand + conditional + leverage. Highest confidence.
    if (nearDemand !== undefined && nearConditional !== undefined) {
      const parts = [nearDemand, nearConditional, lev];
      detections.push({
        type: "safety.extortion",
        span: spanOf(parts),
        confidence: 0.95,
        evidence: `demand "${nearDemand.term}" + condition "${nearConditional.term}" + leverage "${lev.term}"`,
      });
      continue;
    }

    // Partial: demand + leverage with no explicit conditional
    // ("refund me, I have already written the 1 star review").
    if (nearDemand !== undefined) {
      detections.push({
        type: "safety.extortion.implied",
        span: spanOf([nearDemand, lev]),
        confidence: 0.75,
        evidence: `demand "${nearDemand.term}" co-occurring with leverage "${lev.term}"`,
      });
      continue;
    }

    // Partial: conditional + leverage, demand implied
    // ("otherwise I'm leaving a bad review").
    if (nearConditional !== undefined) {
      detections.push({
        type: "safety.extortion.implied",
        span: spanOf([nearConditional, lev]),
        confidence: 0.75,
        evidence: `condition "${nearConditional.term}" + leverage "${lev.term}"`,
      });
    }
  }

  return dedupe(detections);
}

// --- scam links ------------------------------------------------------------

const scam = new AhoCorasick();
scam.addAll(SCAM_URGENCY, "urgency");
scam.addAll(SCAM_PAYMENT, "payment");
scam.addAll(SCAM_TOO_GOOD, "too_good");
scam.build();

/**
 * SPEC §4: url detector output × (payment | urgency | too-good pricing).
 * Takes the URL detections so it composes rather than re-parsing.
 */
export function detectScamLink(views: NormalizedViews, urlDetections: Detection[]): Detection[] {
  if (urlDetections.length === 0) return [];

  const matches = keepLongest(scam.search(views.deleet));
  if (matches.length === 0) return [];

  const tags = new Set(matches.map((m) => m.tag));
  const detections: Detection[] = [];

  for (const url of urlDetections) {
    const reasons = [...tags];
    if (reasons.length === 0) continue;

    // Two or more independent scam cues alongside a link is a strong signal.
    const confidence = Math.min(0.93, 0.6 + reasons.length * 0.12);

    detections.push({
      type: "safety.scamlink",
      span: url.span,
      confidence,
      evidence: `${url.evidence} + ${reasons.join(", ")} cues`,
    });
  }

  return detections;
}

// --- helpers ---------------------------------------------------------------

interface Positioned {
  start: number;
  end: number;
  term: string;
}

function distance(a: Positioned, b: Positioned): number {
  if (a.end < b.start) return b.start - a.end;
  if (b.end < a.start) return a.start - b.end;
  return 0; // overlapping
}

function spanOf(parts: Positioned[]): { start: number; end: number } {
  return {
    start: Math.min(...parts.map((p) => p.start)),
    end: Math.max(...parts.map((p) => p.end)),
  };
}

function dedupe(detections: Detection[]): Detection[] {
  const best = new Map<string, Detection>();
  for (const d of detections) {
    const key = `${d.type}:${d.span.start}:${d.span.end}`;
    const existing = best.get(key);
    if (existing === undefined || d.confidence > existing.confidence) best.set(key, d);
  }
  return [...best.values()];
}
