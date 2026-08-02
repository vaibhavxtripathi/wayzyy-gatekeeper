/**
 * Tier 3 — risk engine + relationship state (SPEC §6).
 *
 * Ties together: session state, windowed re-scan, fragment merging, and the
 * weighted linear score. This is the tier that has to resolve the bulk of
 * traffic — SPEC §6 targets ≥92% decided at or before here.
 */

import { DEFAULT_RISK_CONFIG, type RiskConfig } from "./config.js";
import { buildRescanText, mergeFragments, totalDigitCount, uniqueDigitCount } from "./rescan.js";
import { bandFor, scoreMessage, type Band, type ScoreBreakdown } from "./score.js";
import {
  decayDigitPressure,
  emptyPairState,
  pruneFragments,
  type PairState,
  type SessionStore,
} from "./state.js";
import { runDetectors } from "../detectors/index.js";
import { normalize } from "../normalize/index.js";
import { messageWeirdness, type TrigramModel } from "../weirdness/index.js";
import type { Detection, ModerateRequest, NormalizedViews } from "../types.js";

export interface AssessInput {
  request: ModerateRequest;
  views: NormalizedViews;
  detections: readonly Detection[];
  weirdTokenCount: number;
  /** Injected clock, so tests control decay and windows deterministically. */
  nowMs: number;
}

export interface RiskAssessment {
  band: Band;
  breakdown: ScoreBreakdown;
  /** Detections discovered only by the windowed re-scan. */
  rescanDetections: Detection[];
  /** A number reconstructed from fragments across messages, if any. */
  mergedNumber: { digits: string; contributingRuns: number } | null;
  /** State as it stands after this message. */
  state: PairState;
}

export interface RiskEngineOptions {
  store: SessionStore;
  config?: RiskConfig;
  trigramModel?: TrigramModel;
}

export class RiskEngine {
  private readonly store: SessionStore;
  private readonly config: RiskConfig;
  private readonly trigramModel: TrigramModel | undefined;

  constructor(options: RiskEngineOptions) {
    this.store = options.store;
    this.config = options.config ?? DEFAULT_RISK_CONFIG;
    this.trigramModel = options.trigramModel;
  }

  /**
   * Assess a message against the conversation's accumulated state, then
   * persist the updated state.
   */
  async assess(input: AssessInput): Promise<RiskAssessment> {
    const { request, views, detections, nowMs } = input;
    const session = this.config.session;

    const existing = await this.store.get(request.conversation_id);
    const state = existing ?? emptyPairState(nowMs);

    // --- decay carried-over pressure ---------------------------------------
    const decayedPressure = decayDigitPressure(state, nowMs, session.digitPressureHalfLifeMs);

    // --- windowed re-scan ---------------------------------------------------
    // Concatenate this sender's recent messages and re-run Tier 1+2, so a
    // number split across turns is seen as one run.
    const rescanDetections: Detection[] = [];
    const rescanText = buildRescanText(
      state.lastMessages,
      request.sender_role,
      request.text,
      session.windowedRescanMessages,
    );

    if (rescanText !== null) {
      const rescanViews = normalize(rescanText);
      const rescanResult = runDetectors(rescanViews);
      // Keep only what the per-message pass did not already find: the whole
      // point is detections that exist ONLY across the message boundary.
      const seen = new Set(detections.map((d) => d.type));
      for (const detection of rescanResult.detections) {
        if (seen.has(detection.type)) continue;
        if (!detection.type.startsWith("contact.")) continue;
        rescanDetections.push({
          ...detection,
          evidence: `${detection.evidence} (windowed re-scan across messages)`,
        });
      }
    }

    // --- fragment merging ---------------------------------------------------
    const fragments = pruneFragments(
      state.fragmentBuffer,
      nowMs,
      session.fragmentWindowMs,
      session.fragmentBufferSize,
    );
    const currentFragments = views.digitRuns.map((run) => ({
      run,
      timestamp: nowMs,
      sender: request.sender_role,
    }));
    const allFragments = [...fragments, ...currentFragments];

    const merged = mergeFragments(
      allFragments,
      request.sender_role,
      nowMs,
      session.fragmentWindowMs,
    );
    const validMerge = merged.find((m) => m.validPhone) ?? null;

    // --- score --------------------------------------------------------------
    const combinedDetections = [...detections, ...rescanDetections];
    const breakdown = scoreMessage(
      {
        detections: combinedDetections,
        signals: views.signals,
        digitRuns: views.digitRuns,
        weirdTokenCount: input.weirdTokenCount,
        digitPressure: decayedPressure,
        sessionIntentHits: state.intentHits,
        role: request.sender_role,
        stage: request.booking_stage,
      },
      this.config,
    );

    // A number reconstructed from fragments inside the window is decisive:
    // SPEC §6 says block outright. Force the score past the high band rather
    // than special-casing the verdict, so the band logic stays single-source.
    let band = bandFor(breakdown.score, this.config);
    if (validMerge !== null) {
      band = "block";
      breakdown.contributions["mergedFragments"] = this.config.weights.validPhone;
      breakdown.score = Math.max(breakdown.score, this.config.bands.high + 1);
    }

    // --- persist updated state ----------------------------------------------
    const messageIntentHits = combinedDetections.filter((d) => d.type.startsWith("intent.")).length;

    // Digit pressure accrues from the volume of digits shared, pre-booking
    // being where it matters (SPEC §6). Post-booking numbers are usually
    // legitimate logistics, so they accrue at a heavily reduced rate.
    const pressureDelta =
      totalDigitCount(views.digitRuns) *
      (request.booking_stage === "pre_booking" ? 1 : 0.2);

    const nextState: PairState = {
      digitPressure: decayedPressure + pressureDelta,
      digitPressureUpdatedAt: nowMs,
      fragmentBuffer: pruneFragments(
        allFragments,
        nowMs,
        session.fragmentWindowMs,
        session.fragmentBufferSize,
      ),
      intentHits: state.intentHits + messageIntentHits,
      strikes: state.strikes + (band === "block" ? 1 : 0),
      lastMessages: [
        ...state.lastMessages,
        { text: request.text, sender: request.sender_role, timestamp: nowMs },
      ].slice(-session.lastMessagesSize),
      recentBlocks:
        band === "block"
          ? [...state.recentBlocks, nowMs].filter(
              (t) => nowMs - t <= this.config.policy.blockCooldownWindowMs,
            )
          : state.recentBlocks.filter((t) => nowMs - t <= this.config.policy.blockCooldownWindowMs),
    };

    await this.store.set(request.conversation_id, nextState);

    return {
      band,
      breakdown,
      rescanDetections,
      mergedNumber:
        validMerge !== null
          ? { digits: validMerge.digits, contributingRuns: validMerge.contributingRuns }
          : null,
      state: nextState,
    };
  }

  /** Convenience wrapper that runs Tiers 1-3 in one call. */
  async assessText(request: ModerateRequest, nowMs: number): Promise<RiskAssessment> {
    const views = normalize(request.text);
    const { detections } = runDetectors(views);
    const weirdTokenCount =
      this.trigramModel !== undefined
        ? messageWeirdness(views.folded, this.trigramModel).weirdTokenCount
        : 0;

    return this.assess({ request, views, detections, weirdTokenCount, nowMs });
  }
}

export { DEFAULT_RISK_CONFIG } from "./config.js";
export type { RiskConfig, RiskWeights, SafetyWeights } from "./config.js";
export { bandFor, scoreMessage } from "./score.js";
export type { Band, ScoreBreakdown, ScoreInput } from "./score.js";
export {
  MemorySessionStore,
  decayDigitPressure,
  emptyPairState,
  pruneFragments,
} from "./state.js";
export type { PairState, SessionStore, TimestampedRun, RememberedMessage } from "./state.js";
export { buildRescanText, mergeFragments, totalDigitCount, uniqueDigitCount } from "./rescan.js";
export type { MergedFragment } from "./rescan.js";
