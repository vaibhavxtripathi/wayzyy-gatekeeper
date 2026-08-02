import { beforeEach, describe, expect, it } from "vitest";

import model from "../../../data/trigrams/model.json" with { type: "json" };
import { moderate, moderateStateful } from "../src/index.js";
import { DEFAULT_RISK_CONFIG } from "../src/risk/config.js";
import { mergeFragments } from "../src/risk/rescan.js";
import { bandFor, scoreMessage } from "../src/risk/score.js";
import { MemorySessionStore, decayDigitPressure, emptyPairState } from "../src/risk/state.js";
import { normalize } from "../src/normalize/index.js";
import { runDetectors } from "../src/detectors/index.js";
import type { TrigramModel } from "../src/weirdness/index.js";
import type { BookingStage, ModerateRequest, SenderRole } from "../src/types.js";

const MODEL = model as TrigramModel;
const T0 = 1_700_000_000_000;

function req(
  text: string,
  overrides: Partial<ModerateRequest> = {},
): ModerateRequest {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender_role: "guest",
    booking_stage: "pre_booking",
    text,
    ...overrides,
  };
}

function score(text: string, role: SenderRole = "guest", stage: BookingStage = "pre_booking") {
  const views = normalize(text);
  const { detections } = runDetectors(views);
  return scoreMessage(
    {
      detections,
      signals: views.signals,
      digitRuns: views.digitRuns,
      weirdTokenCount: 0,
      digitPressure: 0,
      sessionIntentHits: 0,
      role,
      stage,
    },
    DEFAULT_RISK_CONFIG,
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe("tier 3 scoring", () => {
  it("blocks a bare valid phone number pre-booking", () => {
    const result = moderate(req("my number is 9876543210"), { trigramModel: MODEL });
    expect(result.verdict).toBe("block");
    expect(result.resolved_by).toBe("tier3.risk");
  });

  it("allows ordinary chat", () => {
    const result = moderate(req("what time is check in?"), { trigramModel: MODEL });
    expect(result.verdict).toBe("allow");
  });

  it("scores both benchmark strings above the allow band", () => {
    for (const text of [
      "hi i a92m a121ksh35ay call me on nine eight 7 six zero",
      "reach out at insta: akshay_98_76_five_four",
    ]) {
      const result = moderate(req(text), { trigramModel: MODEL });
      expect(result.verdict).not.toBe("allow");
    }
  });

  /**
   * A fully-recovered contact identifier is the most certain violation there
   * is. If any of these merely escalate, the cascade spends Tier 4/5 budget
   * on the easiest cases in the product — the opposite of the cost-descending
   * design in SPEC §0.
   */
  it("blocks every unambiguous contact identifier without escalating", () => {
    const unambiguous = [
      "my number is 9876543210",
      "mail me at akshay@gmail.com",
      "pay me at akshay@ybl",
      "https://wa.me/919876543210",
    ];

    for (const text of unambiguous) {
      const result = moderate(req(text), { trigramModel: MODEL });
      expect(result.verdict, text).toBe("block");
    }
  });

  it("reports per-feature contributions for the trace panel", () => {
    const breakdown = score("call me on nine eight 7 six zero");
    expect(Object.keys(breakdown.contributions).length).toBeGreaterThan(0);
    expect(breakdown.contributions["mixedForm"]).toBeGreaterThan(0);
  });
});

describe("stage modifier", () => {
  it("relaxes contact rules post-booking", () => {
    const pre = score("the gate code is at 9876543210", "host", "pre_booking");
    const post = score("the gate code is at 9876543210", "host", "post_booking");
    expect(post.score).toBeLessThan(pre.score);
  });

  it("does NOT relax safety rules post-booking", () => {
    const pre = score("refund me or i will leave a 1 star review", "guest", "pre_booking");
    const post = score("refund me or i will leave a 1 star review", "guest", "post_booking");
    // Safety is scored outside the stage modifier, so it survives intact.
    expect(post.safetyRaw).toBe(pre.safetyRaw);
    expect(post.safetyRaw).toBeGreaterThan(0);
  });

  it("still blocks threats post-booking", () => {
    const result = moderate(
      req("i will kill you", { booking_stage: "post_booking" }),
      { trigramModel: MODEL },
    );
    expect(result.verdict).toBe("block");
  });
});

describe("role modifier", () => {
  it("weights a host pushing off-platform above a guest", () => {
    const guest = score("lets book direct next time", "guest");
    const host = score("lets book direct next time", "host");
    expect(host.score).toBeGreaterThan(guest.score);
  });
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

describe("digit pressure decay", () => {
  it("halves over one half-life", () => {
    const state = { ...emptyPairState(T0), digitPressure: 10 };
    const halfLife = DEFAULT_RISK_CONFIG.session.digitPressureHalfLifeMs;
    expect(decayDigitPressure(state, T0 + halfLife, halfLife)).toBeCloseTo(5, 5);
  });

  it("does not grow over time", () => {
    const state = { ...emptyPairState(T0), digitPressure: 10 };
    expect(decayDigitPressure(state, T0, 1000)).toBe(10);
  });
});

describe("relationship-level accumulation", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("accumulates digit pressure across messages", async () => {
    const first = await moderateStateful(req("my room is 4455"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    const second = await moderateStateful(req("and 7788", { message_id: "m2" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });

    expect(second.signals.digit_pressure as number).toBeGreaterThan(
      first.signals.digit_pressure as number,
    );
  });

  it("keeps state separate per conversation", async () => {
    await moderateStateful(req("9876543210"), { store, nowMs: T0 });
    const other = await moderateStateful(
      req("hello there", { conversation_id: "c2" }),
      { store, nowMs: T0 },
    );
    expect(other.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Multi-message tests (SPEC §12 step 5)
// ---------------------------------------------------------------------------

describe("split-number detection across messages", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("catches a number split across two messages by the same sender", async () => {
    // "98765" ... (later) ... "43210" — invisible to any per-message detector.
    const first = await moderateStateful(req("98765"), { store, nowMs: T0 });
    expect(first.verdict).not.toBe("block");

    const second = await moderateStateful(req("43210", { message_id: "m2" }), {
      store,
      nowMs: T0 + 60_000,
    });

    expect(second.verdict).toBe("block");
    expect(second.signals.merged_fragments).toBe("9876543210");
  });

  it("does not merge fragments from different senders", async () => {
    await moderateStateful(req("98765", { sender_role: "guest" }), { store, nowMs: T0 });
    const hostReply = await moderateStateful(
      req("43210", { message_id: "m2", sender_role: "host" }),
      { store, nowMs: T0 + 60_000 },
    );

    // Merging across senders would manufacture a number nobody sent.
    expect(hostReply.signals.merged_fragments).toBeUndefined();
  });

  it("does not merge fragments outside the 30-minute window", async () => {
    await moderateStateful(req("98765"), { store, nowMs: T0 });
    const late = await moderateStateful(req("43210", { message_id: "m2" }), {
      store,
      nowMs: T0 + 31 * 60 * 1000,
    });

    expect(late.signals.merged_fragments).toBeUndefined();
  });

  it("does not fabricate a number from unrelated digits", async () => {
    // Prices and guest counts must not merge into a phone number.
    await moderateStateful(req("the rate is 4500 per night"), { store, nowMs: T0 });
    const second = await moderateStateful(
      req("we are 4 adults", { message_id: "m2" }),
      { store, nowMs: T0 + 1000 },
    );

    expect(second.signals.merged_fragments).toBeUndefined();
    expect(second.verdict).toBe("allow");
  });
});

describe("windowed re-scan", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("sees intent that spans a message boundary", async () => {
    await moderateStateful(req("hey quick question"), { store, nowMs: T0 });
    const second = await moderateStateful(
      req("can we take this offline", { message_id: "m2" }),
      { store, nowMs: T0 + 1000 },
    );

    expect(second.categories).toContain("intent.offplatform");
  });
});

describe("mergeFragments", () => {
  const run = (digits: string) => ({
    digits,
    sourceSpan: { start: 0, end: digits.length },
    wordFormCount: 0,
    numeralCount: 1,
    separatorTypes: ["none" as const],
    mixedForm: false,
  });

  it("recognises a valid IN mobile assembled from two fragments", () => {
    const merged = mergeFragments(
      [
        { run: run("98765"), timestamp: T0, sender: "guest" },
        { run: run("43210"), timestamp: T0 + 1000, sender: "guest" },
      ],
      "guest",
      T0 + 2000,
      30 * 60 * 1000,
    );

    expect(merged[0]?.digits).toBe("9876543210");
    expect(merged[0]?.validPhone).toBe(true);
  });

  it("returns nothing for a single fragment", () => {
    expect(
      mergeFragments([{ run: run("98765"), timestamp: T0, sender: "guest" }], "guest", T0, 60_000),
    ).toEqual([]);
  });

  it("does not mark a short combination as a valid phone", () => {
    const merged = mergeFragments(
      [
        { run: run("123"), timestamp: T0, sender: "guest" },
        { run: run("456"), timestamp: T0, sender: "guest" },
      ],
      "guest",
      T0,
      60_000,
    );
    expect(merged.every((m) => !m.validPhone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

describe("bands", () => {
  it("maps scores to allow / escalate / block", () => {
    expect(bandFor(0, DEFAULT_RISK_CONFIG)).toBe("allow");
    expect(bandFor(5, DEFAULT_RISK_CONFIG)).toBe("escalate");
    expect(bandFor(20, DEFAULT_RISK_CONFIG)).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// Hard negatives must survive Tier 3 (SPEC §10 friction budget)
// ---------------------------------------------------------------------------

describe("hard negatives are allowed at tier 3", () => {
  const negatives = [
    "the total is ₹98,765 for 5 nights",
    "check in is at 2pm on 15 March",
    "pin code 403507",
    "booking ref WYZ8842",
    "villa 12, second floor",
    "flight 6E 2134 lands at 9pm",
    "we are 4 adults and 2 kids",
    "the beach is 700m away",
    "wifi password is sunshine2024",
    "iPhone 15 Pro, 256GB",
    "lets call it a day",
    "i left a 5 star review already, loved it",
    "the gate code is 4455",
    "could i get a refund for the extra night?",
  ];

  for (const text of negatives) {
    it(`allows: "${text}"`, () => {
      const result = moderate(req(text), { trigramModel: MODEL });
      expect(result.verdict).toBe("allow");
    });
  }
});

/**
 * Gaps the live red team found (SPEC §10). Each was a real leak the labelled
 * corpus did not contain, which is the argument for running the loop at all:
 * a corpus can only test the evasions someone already thought of.
 */
describe("red-team regressions", () => {
  const cases: string[] = [
    // The lexicon covered OFFERING contact info but not REQUESTING it.
    "can you send me your number?",
    "whats your number",
    "aapka number bhej do",
    "Can you send me a link to your profile on LinkedIn?",
    "Can you send me a message on Telegram?",
    // Naming a channel AND asking to move to it: neither hit is decisive
    // alone, and the attacker walked through the gap between them.
    "dm me on whatsapp",
    "Can you DM me on WhatsApp for the booking?",
    // A full-length run next to "my number is", failing country validation.
    "My number is 1234567890, but you can call me on +91 1234567890",
  ];

  for (const text of cases) {
    it(`stops: "${text.slice(0, 46)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).not.toBe("allow");
    });
  }

  /** The same fixes must not start flagging ordinary hospitality talk. */
  const stillAllowed: string[] = [
    "I'm available on 9 PM IST, what's your time?",
    "Can you send me a screenshot of your ID?",
    "My friend is coming with me, can you accommodate 3 people?",
    "is there a landline in the room i can use?",
    "the emergency contact number in the house manual is smudged",
    "do you have a direct line for the caretaker in case of emergency?",
  ];

  for (const text of stillAllowed) {
    it(`allows: "${text.slice(0, 46)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }
});

/**
 * A guest reporting a scam is the message a platform MOST wants delivered.
 * Third-party framing names a channel and an action, so the off-platform floor
 * would otherwise fire on someone warning the host about a fraud attempt.
 */
describe("reporting an approach is not making one", () => {
  const reports = [
    "someone messaged me on whatsapp claiming to be you, is that real?",
    "please confirm you never ask for payment over whatsapp",
  ];

  for (const text of reports) {
    it(`allows: "${text.slice(0, 44)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }

  it("does not BLOCK a report that also names off-platform payment", () => {
    // "i got a text asking for payment outside the app, is it legitimate?"
    // still scores from the off-platform hit itself, which is defensible — a
    // second look is reasonable. What must not happen is a block, which would
    // silence someone reporting fraud.
    const result = moderate(
      req("i got a text asking for payment outside the app, is it legitimate?"),
      { trigramModel: MODEL },
    );
    expect(result.verdict).not.toBe("block");
  });

  it("still stops the same channel used as a first-person request", () => {
    expect(moderate(req("message me on whatsapp"), { trigramModel: MODEL }).verdict).not.toBe(
      "allow",
    );
  });
});

/**
 * A message with no detections of its own must never be escalated purely by
 * relationship carryover (digitPressure, sessionIntentHits). Found via manual
 * testing: "hi and welcome to this property" was blocking because it inherited
 * a stale intent hit and digit pressure from an EARLIER, unrelated message in
 * the same conversation.
 */
describe("contentless messages never inherit a block from session state", () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it("allows ordinary greetings immediately after a real evasion in the same conversation", async () => {
    await moderateStateful(req("hi i a92m a121ksh35ay call me on nine eight 7 six zero"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });

    for (const text of ["hi and welcome to this property", "hello", "hi", "good morning", "thank you"]) {
      const result = await moderateStateful(
        req(text, { message_id: `m_${text}`, sender_role: "host" }),
        { store, trigramModel: MODEL, nowMs: T0 + 1000 },
      );
      expect(result.verdict, text).toBe("allow");
    }
  });

  it("still blocks a genuine evasion in the same conversation right after", async () => {
    await moderateStateful(req("hi i a92m a121ksh35ay call me on nine eight 7 six zero"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });
    await moderateStateful(req("hi and welcome!", { message_id: "m2", sender_role: "host" }), {
      store,
      trigramModel: MODEL,
      nowMs: T0 + 1000,
    });

    const result = await moderateStateful(
      req("my number is 9876543210", { message_id: "m3" }),
      { store, trigramModel: MODEL, nowMs: T0 + 2000 },
    );
    expect(result.verdict).toBe("block");
  });
});

/**
 * Reported from manual testing: a bare 8-digit run was silently ALLOWED.
 * SPEC §4 says partials must not auto-block; it does not say they should pass
 * unremarked. 5-6 digit runs still stay quiet because they overlap PIN codes,
 * prices and booking refs.
 */
describe("long unexplained digit runs are not silently allowed", () => {
  for (const text of ["22352352", "12345678", "987654321"]) {
    it(`stops: "${text}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).not.toBe("allow");
    });
  }

  for (const text of [
    "the pin code here is 403507",
    "booking ref WYZ8842",
    "the total is ₹98,765 for 5 nights",
    "flight 6E 2134 lands at 9pm",
    "we are 4 adults and 2 kids",
  ]) {
    it(`still allows: "${text.slice(0, 40)}"`, () => {
      expect(moderate(req(text), { trigramModel: MODEL }).verdict).toBe("allow");
    });
  }
});

/**
 * The windowed re-scan finds evidence across turns, but that evidence belongs
 * to EARLIER messages. Reporting it in `categories` made the engine claim
 * "looks like a phone number" about a message containing no number, and
 * produced spans that do not index into this message's text.
 */
describe("cross-message evidence is reported separately", () => {
  it("does not attribute an earlier message's categories to this one", async () => {
    const store = new MemorySessionStore();
    await moderateStateful(req("this is my phone no 9876543210"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });

    const result = await moderateStateful(
      req("lets book direct next time", { message_id: "m2" }),
      { store, trigramModel: MODEL, nowMs: T0 + 1000 },
    );

    expect(result.categories).toContain("intent.offplatform");
    expect(result.categories).not.toContain("contact.phone");
  });

  /**
   * A number contained entirely within ONE earlier message is not
   * cross-boundary evidence — it was caught on its own turn. Re-charging it
   * to every later message scored innocent prices and flight numbers at full
   * validPhone weight and blocked them at 13+.
   */
  it("does not re-charge an earlier message's own number to later messages", async () => {
    const store = new MemorySessionStore();
    await moderateStateful(req("my number is 9876543210"), {
      store,
      trigramModel: MODEL,
      nowMs: T0,
    });

    for (const text of [
      "the villa is ₹98,765 for 5 nights, 4 adults 2 kids",
      "flight 6E 2134 lands 9:40, can I check in at 2?",
      "pin code 403507",
      "the gate code is 4455",
    ]) {
      const result = await moderateStateful(req(text, { message_id: `m_${text}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + 60_000,
      });
      expect(result.verdict, text).toBe("allow");
    }
  });

  /**
   * Merging must not concatenate unrelated digits into a fake number. One
   * real number in the buffer glued itself to every later price, flight
   * number and clock time, producing 20+ digit strings that still validated
   * because only the leading 10 digits were checked.
   */
  it("never fabricates an over-length number from unrelated digits", async () => {
    const store = new MemorySessionStore();
    const texts = [
      "my number is 9876543210",
      "the villa is ₹98,765 for 5 nights, 4 adults 2 kids",
      "flight 6E 2134 lands 9:40, can I check in at 2?",
    ];

    for (const [i, text] of texts.entries()) {
      const result = await moderateStateful(req(text, { message_id: `m${i}` }), {
        store,
        trigramModel: MODEL,
        nowMs: T0 + i * 1000,
      });
      const merged = result.signals["merged_fragments"];
      if (typeof merged === "string") {
        expect(merged.length, `${text} -> ${merged}`).toBeLessThanOrEqual(12);
      }
    }
  });
});
