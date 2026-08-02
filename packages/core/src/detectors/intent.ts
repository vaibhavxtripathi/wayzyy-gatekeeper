/**
 * SPEC §4 `intent` detector.
 *
 * Aho-Corasick over the intent lexicon, run on the DELEET view so leet
 * spellings (`c4ll`, `wh4tsapp`) are caught. Matches falling inside a known
 * benign phrase are suppressed — "call it a day" is called out as an explicit
 * FP trap in SPEC §10.
 */

import { AhoCorasick, keepLongest } from "./aho.js";
import {
  INTENT_ACTION,
  INTENT_CHANNEL,
  INTENT_NEGATIVE_CONTEXT,
  INTENT_OFFPLATFORM,
  INTENT_PAYMENT,
} from "./lexicons.js";
import type { Detection, NormalizedViews } from "../types.js";

const automaton = new AhoCorasick();
automaton.addAll(INTENT_CHANNEL, "intent.channel");
automaton.addAll(INTENT_ACTION, "intent.contact");
automaton.addAll(INTENT_OFFPLATFORM, "intent.offplatform");
automaton.addAll(INTENT_PAYMENT, "intent.payment");
automaton.build();

const negatives = new AhoCorasick();
negatives.addAll(INTENT_NEGATIVE_CONTEXT, "negative");
negatives.build();

const CONFIDENCE: Record<string, number> = {
  "intent.channel": 0.7,
  "intent.contact": 0.8,
  "intent.offplatform": 0.9,
  "intent.payment": 0.75,
};

export function detectIntent(views: NormalizedViews): Detection[] {
  // deleet recovers leet-spelled intent words; it is the right view here and
  // (unlike denoised) leaves word boundaries intact.
  const text = views.deleet;

  const suppressed = negatives.search(text);
  const matches = keepLongest(automaton.search(text));

  const detections: Detection[] = [];
  for (const match of matches) {
    // Suppress when the hit sits entirely inside a benign phrase.
    const inNegative = suppressed.some((n) => n.start <= match.start && n.end >= match.end);
    if (inNegative) continue;

    detections.push({
      type: match.tag,
      span: { start: match.start, end: match.end },
      confidence: CONFIDENCE[match.tag] ?? 0.7,
      evidence: match.term,
    });
  }

  return detections;
}

/** Distinct intent terms hit, for the `signals.intent_hits` field (SPEC §2). */
export function intentHits(detections: Detection[]): string[] {
  return [...new Set(detections.filter((d) => d.type.startsWith("intent.")).map((d) => d.evidence))];
}
