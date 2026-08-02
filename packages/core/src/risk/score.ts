/**
 * Tier 3 scoring (SPEC §6).
 *
 * Weighted linear model over Tier 1-2 signals plus relationship-level state.
 * Contact risk and safety risk are scored SEPARATELY and combined at the end,
 * because the stage modifier must relax contact rules post-booking (a host
 * legitimately shares an address and gate code) while safety rules stay fully
 * armed at every stage.
 */

import type { RiskConfig } from "./config.js";
import type { Detection, DigitRun, NormalizationSignals } from "../types.js";
import type { BookingStage, SenderRole } from "../types.js";

export interface ScoreInput {
  detections: readonly Detection[];
  signals: NormalizationSignals;
  digitRuns: readonly DigitRun[];
  /** Count of tokens judged weird (NOT the raw max score — see weirdness §5). */
  weirdTokenCount: number;
  /** Decayed digit pressure carried by the conversation. */
  digitPressure: number;
  /** Cumulative intent hits across the conversation. */
  sessionIntentHits: number;
  role: SenderRole;
  stage: BookingStage;
}

export interface ScoreBreakdown {
  /** Final score after modifiers. */
  score: number;
  /** Contact-risk subtotal, before the stage/role modifiers. */
  contactRaw: number;
  /** Safety-risk subtotal. Never relaxed by stage. */
  safetyRaw: number;
  /** Per-feature contributions, for the playground trace panel. */
  contributions: Record<string, number>;
  stageModifier: number;
  roleModifier: number;
}

export function scoreMessage(input: ScoreInput, config: RiskConfig): ScoreBreakdown {
  const w = config.weights;
  const sw = config.safetyWeights;
  const contributions: Record<string, number> = {};

  const add = (key: string, value: number) => {
    if (value === 0) return;
    contributions[key] = (contributions[key] ?? 0) + value;
  };

  const has = (prefix: string) => input.detections.some((d) => d.type.startsWith(prefix));
  const count = (prefix: string) => input.detections.filter((d) => d.type.startsWith(prefix)).length;

  // --- contact risk --------------------------------------------------------
  let contact = 0;

  // w1 · validPhone — a complete, valid number.
  if (input.detections.some((d) => d.type === "contact.phone" || d.type === "contact.phone.obfuscated")) {
    contact += w.validPhone;
    add("validPhone", w.validPhone);
  }

  // w2 · partialPhone · (len/10) — scaled by how much of a number is present.
  const partials = input.detections.filter((d) => d.type.startsWith("contact.phone.partial"));
  if (partials.length > 0) {
    const longest = Math.max(
      ...input.digitRuns.map((r) => r.digits.length),
      0,
    );
    const value = w.partialPhone * Math.min(1, longest / 10);
    contact += value;
    add("partialPhone", value);
  }

  // w3 · mixedForm — words and numerals interleaved almost never occurs in
  // legit text, so this is the highest-value Tier 1 signal (SPEC §3.6).
  const mixedForms = input.digitRuns.filter((r) => r.mixedForm).length;
  if (mixedForms > 0) {
    const value = w.mixedForm * mixedForms;
    contact += value;
    add("mixedForm", value);
  }

  // w4 · noiseDigitsRemoved — mangling proves intent (SPEC §3.4).
  if (input.signals.noiseDigitsRemoved > 0) {
    const value = w.noiseDigitsRemoved * input.signals.noiseDigitsRemoved;
    contact += value;
    add("noiseDigitsRemoved", value);
  }

  // w5 · weirdnessFlags
  if (input.weirdTokenCount > 0) {
    const value = w.weirdnessFlags * input.weirdTokenCount;
    contact += value;
    add("weirdnessFlags", value);
  }

  // w6 · intentHits — message-level hits plus what the pair has accumulated.
  const messageIntent = count("intent.");
  const offPlatform = count("intent.offplatform");
  const totalIntent = messageIntent + input.sessionIntentHits;
  if (totalIntent > 0) {
    // Off-platform intent is the highest-value family, so it counts double.
    const value = w.intentHits * (totalIntent + offPlatform);
    contact += value;
    add("intentHits", value);
  }

  // "book direct", "take this offline" carry no contact info at all, so they
  // accumulate no other signal — yet they are exactly the disintermediation
  // the product exists to stop. Without a floor they score below the allow
  // band and are delivered untouched.
  //
  // The same applies to naming a channel AND asking to move to it ("dm me on
  // whatsapp"): neither hit is decisive alone, but together they are a request
  // to leave the platform, and the red team walked straight through the gap
  // between them.
  // Explicitly asking for a phone number is unambiguous on its own — no
  // channel, no digits, no second signal to accumulate. "can you send me your
  // number?" scored 1.1 and was delivered until the red team found it.
  const asksForNumber = input.detections.some(
    (d) =>
      d.type.startsWith("intent.contact") &&
      /\b(?:number|contact|handle|details)\b/.test(d.evidence) &&
      /\b(?:send|give|share|drop|have|whats|what is|bhej|de do)\b/.test(d.evidence),
  );

  const channelPlusAction = count("intent.channel") > 0 && count("intent.contact") > 0;
  if (offPlatform > 0 || channelPlusAction || asksForNumber) {
    const floor = w.offPlatformFloor - contact;
    if (floor > 0) {
      contact += floor;
      add("offPlatformFloor", floor);
    }
  }

  // A contact request sitting next to a full-length digit run is a number
  // being shared, even when it fails country validation ("my number is
  // 1234567890"). Requiring a VALID number here would mean any non-IN or
  // fictional number sails through next to an explicit "my number is".
  const longRun = input.digitRuns.some((r) => r.digits.length >= 10);
  const askingForContact = count("intent.contact") > 0;
  if (longRun && askingForContact && !has("contact.phone")) {
    contact += w.validPhone * 0.75;
    add("unvalidatedNumber", w.validPhone * 0.75);
  }

  // w7 · handle
  if (has("contact.handle")) {
    contact += w.handle;
    add("handle", w.handle);
  }

  // w8 · upi
  if (has("payment.upi")) {
    contact += w.upi;
    add("upi", w.upi);
  }

  // w9 · riskyUrl — messenger/shortener/payment/homograph/risky-TLD links.
  const riskyUrl = input.detections.filter(
    (d) =>
      d.type.startsWith("contact.url.") &&
      d.type !== "contact.url",
  ).length;
  if (riskyUrl > 0) {
    const value = w.riskyUrl * Math.min(2, riskyUrl);
    contact += value;
    add("riskyUrl", value);
  }

  // w10 · digitPressure — relationship-level accumulation.
  if (input.digitPressure > 0) {
    const value = w.digitPressure * input.digitPressure;
    contact += value;
    add("digitPressure", value);
  }

  // w11 · zeroWidthCount — invisible characters are never accidental.
  if (input.signals.zeroWidthCount > 0) {
    const value = w.zeroWidthCount * input.signals.zeroWidthCount;
    contact += value;
    add("zeroWidthCount", value);
  }

  // email + confusables (beyond the SPEC's w1..w11 sketch, same mechanism).
  if (has("contact.email")) {
    contact += w.email;
    add("email", w.email);
  }
  if (input.signals.confusablesFolded > 0) {
    const value = w.confusablesFolded * input.signals.confusablesFolded;
    contact += value;
    add("confusablesFolded", value);
  }

  // --- safety risk ---------------------------------------------------------
  // Scored separately: safety is NOT relaxed post-booking (SPEC §6).
  let safety = 0;

  const sevWeights: Array<[string, number]> = [
    ["safety.hostility.sev3", sw.hostilitySev3],
    ["safety.hostility.sev2", sw.hostilitySev2],
    ["safety.hostility.sev1", sw.hostilitySev1],
  ];
  for (const [type, weight] of sevWeights) {
    if (input.detections.some((d) => d.type === type)) {
      safety += weight;
      add(type, weight);
      break; // highest severity only, not cumulative
    }
  }

  if (input.detections.some((d) => d.type === "safety.extortion")) {
    safety += sw.extortion;
    add("extortion", sw.extortion);
  } else if (input.detections.some((d) => d.type === "safety.extortion.implied")) {
    safety += sw.extortionImplied;
    add("extortionImplied", sw.extortionImplied);
  }

  if (has("safety.scamlink")) {
    safety += sw.scamlink;
    add("scamlink", sw.scamlink);
  }

  // --- modifiers -----------------------------------------------------------
  const stageModifier = config.modifiers.stage[input.stage] ?? 1;
  const roleModifier = config.modifiers.role[input.role] ?? 1;

  // Stage relaxes contact only. Role asymmetry (a host pushing off-platform is
  // worse than a guest) applies to contact risk, where the fraud lives.
  const score = contact * stageModifier * roleModifier + safety;

  return {
    score,
    contactRaw: contact,
    safetyRaw: safety,
    contributions,
    stageModifier,
    roleModifier,
  };
}

/** Band the score into a tier decision (SPEC §6). */
export type Band = "allow" | "escalate" | "block";

export function bandFor(score: number, config: RiskConfig): Band {
  if (score < config.bands.low) return "allow";
  if (score > config.bands.high) return "block";
  return "escalate";
}
