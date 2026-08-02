/**
 * Gatekeeper engine entry point.
 *
 * Cost-descending cascade (SPEC §0): free deterministic tiers resolve the vast
 * majority of messages; only borderline traffic escalates. Tiers land in build
 * order (SPEC §12) — Tiers 1 and 2 are in place; risk scoring arrives at step 5.
 */

import { now } from "./clock.js";
import { runDetectors } from "./detectors/index.js";
import { normalize } from "./normalize/index.js";
import type { Category, ModerateRequest, ModerateResult } from "./types.js";

export function moderate(req: ModerateRequest): ModerateResult {
  const started = now();

  const views = normalize(req.text);
  const { detections, intentHits } = runDetectors(views);

  const categories: Category[] = [...new Set(detections.map((d) => d.type))];
  const confidence = detections.reduce((max, d) => Math.max(max, d.confidence), 0);

  // Verdict stays `allow` until Tier 3 scoring lands (build-order step 5).
  // Detections and signals are already reported so the benchmark harness and
  // the playground trace panel have real data to work with.
  return {
    verdict: "allow",
    categories,
    spans: detections.map((d) => ({ start: d.span.start, end: d.span.end, type: d.type })),
    confidence: detections.length > 0 ? confidence : 1,
    resolved_by: detections.length > 0 ? "tier2.intent" : "tier1.normalize",
    signals: {
      intent_hits: intentHits,
      noise_digits_removed: views.signals.noiseDigitsRemoved,
      zero_width_count: views.signals.zeroWidthCount,
      confusables_folded: views.signals.confusablesFolded,
      digit_runs: views.digitRuns.length,
      detections: detections.length,
    },
    latency_ms: now() - started,
    cost_usd: 0,
  };
}

export { normalize } from "./normalize/index.js";
export { runDetectors } from "./detectors/index.js";
export * from "./types.js";
