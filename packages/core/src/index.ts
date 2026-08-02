/**
 * Gatekeeper engine entry point.
 *
 * Cost-descending cascade (SPEC §0): free deterministic tiers resolve the vast
 * majority of messages; only borderline traffic escalates. Tiers land in build
 * order (SPEC §12) — this is currently the Tier 1 skeleton.
 */

import { normalize } from "./normalize/index.js";
import { now } from "./clock.js";
import type { ModerateRequest, ModerateResult } from "./types.js";

export function moderate(req: ModerateRequest): ModerateResult {
  const started = now();

  const views = normalize(req.text);

  // Tiers 2-5 attach here in build-order steps 3-8. Until then every message
  // is allowed, but normalization signals are already reported so the
  // playground trace panel and benchmark harness have something to show.
  return {
    verdict: "allow",
    categories: [],
    spans: [],
    confidence: 1,
    resolved_by: "tier1.normalize",
    signals: {
      noise_digits_removed: views.signals.noiseDigitsRemoved,
      zero_width_count: views.signals.zeroWidthCount,
      digit_runs: views.digitRuns.length,
    },
    latency_ms: now() - started,
    cost_usd: 0,
  };
}

export { normalize } from "./normalize/index.js";
export * from "./types.js";
