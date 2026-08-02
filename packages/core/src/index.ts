/**
 * Gatekeeper engine entry point.
 *
 * Cost-descending cascade (SPEC §0): free deterministic tiers resolve the vast
 * majority of messages; only borderline traffic escalates. Tiers land in build
 * order (SPEC §12) — Tiers 1-3 are in place; Tier 4 arrives at step 7.
 */

import { now } from "./clock.js";
import { runDetectors } from "./detectors/index.js";
import { normalize } from "./normalize/index.js";
import { RiskEngine, bandFor, type Band } from "./risk/index.js";
import { DEFAULT_RISK_CONFIG, type RiskConfig } from "./risk/config.js";
import { scoreMessage } from "./risk/score.js";
import type { SessionStore } from "./risk/state.js";
import { messageWeirdness, type TrigramModel } from "./weirdness/index.js";
import type {
  Category,
  ModerateRequest,
  ModerateResult,
  ResolvedBy,
  Span,
  Verdict,
} from "./types.js";

export interface ModerateOptions {
  /**
   * Trigram model for the weirdness meter (SPEC §5). Injected rather than
   * loaded, because core does no fs I/O (SPEC §1). Omit to skip weirdness.
   */
  trigramModel?: TrigramModel;
  /** Tier 3 weights and bands. Defaults to DEFAULT_RISK_CONFIG. */
  config?: RiskConfig;
  /** Injected clock, so tests and benchmarks are deterministic. */
  nowMs?: number;
}

export interface ModerateStatefulOptions extends ModerateOptions {
  /** Session store enabling relationship-level accumulation (SPEC §6). */
  store: SessionStore;
}

/**
 * Stateless moderation: Tiers 1-3 over a single message, with no
 * relationship-level accumulation. Use `moderateStateful` when a
 * conversation_id's history should count.
 */
export function moderate(req: ModerateRequest, options: ModerateOptions = {}): ModerateResult {
  const started = now();
  const config = options.config ?? DEFAULT_RISK_CONFIG;

  const views = normalize(req.text);
  const { detections, intentHits } = runDetectors(views);

  // Weirdness runs on the folded view: confusables are already ASCII, but the
  // noise digits that make mangling visible are still present.
  const weirdness =
    options.trigramModel !== undefined
      ? messageWeirdness(views.folded, options.trigramModel)
      : null;

  const breakdown = scoreMessage(
    {
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      weirdTokenCount: weirdness?.weirdTokenCount ?? 0,
      digitPressure: 0,
      sessionIntentHits: 0,
      role: req.sender_role,
      stage: req.booking_stage,
    },
    config,
  );

  const band = bandFor(breakdown.score, config);

  return buildResult({
    band,
    detections,
    intentHits,
    views,
    weirdness,
    breakdown,
    started,
  });
}

/**
 * Stateful moderation: Tiers 1-3 with relationship-level accumulation,
 * windowed re-scan and cross-message fragment merging (SPEC §6).
 */
export async function moderateStateful(
  req: ModerateRequest,
  options: ModerateStatefulOptions,
): Promise<ModerateResult> {
  const started = now();
  const config = options.config ?? DEFAULT_RISK_CONFIG;
  const nowMs = options.nowMs ?? Date.now();

  const views = normalize(req.text);
  const { detections, intentHits } = runDetectors(views);
  const weirdness =
    options.trigramModel !== undefined
      ? messageWeirdness(views.folded, options.trigramModel)
      : null;

  const engine = new RiskEngine({
    store: options.store,
    config,
    ...(options.trigramModel !== undefined ? { trigramModel: options.trigramModel } : {}),
  });

  const assessment = await engine.assess({
    request: req,
    views,
    detections,
    weirdTokenCount: weirdness?.weirdTokenCount ?? 0,
    nowMs,
  });

  return buildResult({
    band: assessment.band,
    detections: [...detections, ...assessment.rescanDetections],
    intentHits,
    views,
    weirdness,
    breakdown: assessment.breakdown,
    started,
    extraSignals: {
      digit_pressure: round(assessment.state.digitPressure),
      session_intent_hits: assessment.state.intentHits,
      strikes: assessment.state.strikes,
      ...(assessment.mergedNumber !== null
        ? {
            merged_fragments: assessment.mergedNumber.digits,
            merged_from_messages: assessment.mergedNumber.contributingRuns,
          }
        : {}),
    },
  });
}

interface BuildResultInput {
  band: Band;
  detections: readonly import("./types.js").Detection[];
  intentHits: string[];
  views: import("./types.js").NormalizedViews;
  weirdness: ReturnType<typeof messageWeirdness> | null;
  breakdown: ReturnType<typeof scoreMessage>;
  started: number;
  extraSignals?: Record<string, unknown>;
}

function buildResult(input: BuildResultInput): ModerateResult {
  const { band, detections, intentHits, views, weirdness, breakdown, started } = input;

  const categories: Category[] = [...new Set(detections.map((d) => d.type))];
  const spans: Span[] = detections.map((d) => ({
    start: d.span.start,
    end: d.span.end,
    type: d.type,
  }));

  // Tier 4 lands at build step 7; until then an escalate band resolves as
  // `review` rather than silently allowing, which is the conservative reading
  // of SPEC §2's failure policy.
  const verdict: Verdict = band === "allow" ? "allow" : band === "block" ? "block" : "review";
  const resolvedBy: ResolvedBy = band === "allow" && detections.length === 0
    ? "tier1.normalize"
    : "tier3.risk";

  return {
    verdict,
    categories,
    spans,
    confidence: detections.reduce((max, d) => Math.max(max, d.confidence), band === "allow" ? 1 : 0),
    resolved_by: resolvedBy,
    signals: {
      intent_hits: intentHits,
      risk_score: round(breakdown.score),
      contact_score: round(breakdown.contactRaw),
      safety_score: round(breakdown.safetyRaw),
      contributions: breakdown.contributions,
      stage_modifier: breakdown.stageModifier,
      role_modifier: breakdown.roleModifier,
      noise_digits_removed: views.signals.noiseDigitsRemoved,
      zero_width_count: views.signals.zeroWidthCount,
      confusables_folded: views.signals.confusablesFolded,
      digit_runs: views.digitRuns.length,
      detections: detections.length,
      ...(weirdness !== null
        ? { weirdness: round(weirdness.score), weird_tokens: weirdness.weirdTokenCount }
        : {}),
      ...(input.extraSignals ?? {}),
    },
    latency_ms: now() - started,
    cost_usd: 0,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { normalize } from "./normalize/index.js";
export { runDetectors } from "./detectors/index.js";
export { messageWeirdness, scoreToken, percentile } from "./weirdness/index.js";
export type { TrigramModel, MessageWeirdness, TokenScore } from "./weirdness/index.js";
export * from "./risk/index.js";
export * from "./types.js";
