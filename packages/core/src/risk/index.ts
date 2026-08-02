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
  decayIntentHits,
  emptyPairState,
  pruneFragments,
  type PairState,
  type SessionStore,
} from "./state.js";
import { runDetectors } from "../detectors/index.js";
import { normalize } from "../normalize/index.js";
import { messageWeirdness, type TrigramModel } from "../weirdness/index.js";
import type { Detection, ModerateRequest, NormalizedViews } from "../types.js";

/** A run that stands alone as a valid number, so it needs no reassembly. */
function isCompletePhone(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits) || /^91[6-9]\d{9}$/.test(digits);
}

/**
 * Words that give a digit run an innocent reading. A run sitting next to one
 * of these is a flight number, a clock time, a room number or a price — not
 * half of a phone number someone is smuggling out.
 */
const BENIGN_NEIGHBOURS =
  /\b(?:flight|pnr|train|seat|gate|room|villa|flat|apt|floor|lane|door|house|pin|pincode|zip|postal|gst|invoice|ref|booking|order|check|checkin|checkout|night|nights|day|days|adult|adults|kid|kids|guest|guests|person|people|am|pm|rs|inr|price|cost|total|rate|deposit|refund|km|kms|metre|meters|m|gb|mb|tb|iphone|samsung|pixel|pro|max|plus|wifi|password|code)\b/i;

/** How much text on either side counts as "next to" a run. */
const NEIGHBOUR_WINDOW = 20;

/**
 * True when a run could plausibly be part of a number split across messages.
 *
 * A genuine split ("98765" … "43210") arrives as bare digits with nothing
 * explaining them. A flight number, a price or a clock time always travels
 * with a word that gives it meaning — and must never be buffered, or unrelated
 * fragments eventually assemble into a valid-looking mobile by chance.
 */
function isPlausibleFragment(
  run: { digits: string; sourceSpan: { start: number; end: number } },
  views: NormalizedViews,
): boolean {
  // Very short runs carry almost no information and are usually counts.
  if (run.digits.length < 3) return false;

  const text = views.denoised;
  const before = text.slice(Math.max(0, run.sourceSpan.start - NEIGHBOUR_WINDOW), run.sourceSpan.start);
  const after = text.slice(run.sourceSpan.end, run.sourceSpan.end + NEIGHBOUR_WINDOW);

  return !BENIGN_NEIGHBOURS.test(before) && !BENIGN_NEIGHBOURS.test(after);
}

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
    // Same half-life as digit pressure: both measure recent behaviour, not a
    // permanent record.
    const decayedIntentHits = decayIntentHits(state, nowMs, session.digitPressureHalfLifeMs);

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

      // A detection that any SINGLE message already produces on its own is
      // not a cross-boundary find — it was caught on its own turn and must
      // not be re-charged to this one. Without this, an earlier
      // "my number is 9876543210" was re-detected in every later message's
      // re-scan window and scored at full validPhone weight, so an innocent
      // price or flight number blocked at 13+.
      const seen = new Set(detections.map((d) => d.type));
      for (const remembered of state.lastMessages) {
        if (remembered.sender !== request.sender_role) continue;
        for (const d of runDetectors(normalize(remembered.text)).detections) {
          seen.add(d.type);
        }
      }

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
    // Only runs that plausibly belong to a SPLIT phone number are buffered.
    //
    // Two exclusions, both learned the hard way:
    //   - a run that is already a complete valid number was caught on its own
    //     turn and only glues onto later digits if kept;
    //   - a run Tier 2 explained as ordinary content — a flight number, a
    //     clock time, a price, "iPhone 15" — is not a fragment of anything.
    //     Buffering those let "62134" + "940" + "15" assemble into
    //     "6213494015", a structurally valid IN mobile that nobody sent, and
    //     from then on every message blocked.
    const explainedByTier2 = new Set(
      detections
        .filter((d) => !d.type.startsWith("contact.phone"))
        .flatMap((d) => views.digitRuns
          .filter((r) => r.sourceSpan.start >= d.span.start && r.sourceSpan.end <= d.span.end)
          .map((r) => r.digits)),
    );

    const currentFragments = views.digitRuns
      .filter((run) => !isCompletePhone(run.digits))
      .filter((run) => !explainedByTier2.has(run.digits))
      .filter((run) => isPlausibleFragment(run, views))
      .map((run) => ({
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
        sessionIntentHits: decayedIntentHits,
        role: request.sender_role,
        stage: request.booking_stage,
        text: views.folded,
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
    // Only count intent hits belonging to the CURRENT message's sender.
    // rescanDetections are found across THIS sender's recent turns, so they
    // stay in scope; but session.intentHits itself must never mix senders —
    // a guest's "call me" must not inflate the host's next "welcome!".
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
      intentHits: decayedIntentHits + messageIntentHits,
      intentHitsUpdatedAt: nowMs,
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
