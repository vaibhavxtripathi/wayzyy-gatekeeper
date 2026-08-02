import { describe, expect, it } from "vitest";

import { runDetectors } from "../src/detectors/index.js";
import { normalize } from "../src/normalize/index.js";
import type { Detection } from "../src/types.js";

function detect(text: string): Detection[] {
  return runDetectors(normalize(text)).detections;
}

function types(text: string): string[] {
  return detect(text).map((d) => d.type);
}

function hasType(text: string, prefix: string): boolean {
  return types(text).some((t) => t.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Benchmark strings must survive Tier 2 as well
// ---------------------------------------------------------------------------

describe("benchmark strings reach Tier 2 intact", () => {
  it("#1 flags the obfuscated phone and the contact intent", () => {
    const found = types("hi i a92m a121ksh35ay call me on nine eight 7 six zero");
    expect(found.some((t) => t.startsWith("contact.phone"))).toBe(true);
    expect(found.some((t) => t.startsWith("intent."))).toBe(true);
  });

  it("#2 flags the handle and its embedded digits", () => {
    const found = types("reach out at insta: akshay_98_76_five_four");
    expect(found.some((t) => t.startsWith("contact.handle"))).toBe(true);
    expect(found).toContain("contact.handle.embedded_digits");
  });
});

// ---------------------------------------------------------------------------
// phone
// ---------------------------------------------------------------------------

describe("phone detector", () => {
  it("accepts a bare 10-digit IN mobile", () => {
    expect(hasType("9876543210", "contact.phone")).toBe(true);
  });

  it("accepts +91 prefixed numbers", () => {
    expect(hasType("+91 98765 43210", "contact.phone")).toBe(true);
  });

  it("rejects 10-digit runs that cannot be IN mobiles", () => {
    // Leading 1-5 is not a valid IN mobile prefix.
    const found = types("1234567890");
    expect(found).not.toContain("contact.phone");
  });

  it("treats 5-9 digit runs as partials, never as full numbers", () => {
    const found = types("98765");
    expect(found).toContain("contact.phone.partial");
    expect(found).not.toContain("contact.phone");
  });

  it("does not flag a bare PIN code as a partial", () => {
    expect(types("pin code 403507")).not.toContain("contact.phone.partial");
  });

  it("marks obfuscated numbers with the .obfuscated subtype", () => {
    const found = types("call me on nine eight seven six five four three two one zero");
    expect(found.some((t) => t.includes("obfuscated"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

describe("email detector", () => {
  it("catches plain addresses", () => {
    expect(hasType("mail me at akshay@gmail.com", "contact.email")).toBe(true);
  });

  it("catches (at)/(dot) obfuscation", () => {
    expect(hasType("akshay (at) gmail (dot) com", "contact.email")).toBe(true);
    expect(hasType("akshay[at]gmail[dot]com", "contact.email")).toBe(true);
  });

  it("catches spelled-out 'gmail dot com'", () => {
    expect(hasType("akshay at gmail dot com", "contact.email")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

describe("url detector", () => {
  it("flags messenger domains", () => {
    expect(types("https://wa.me/919876543210")).toContain("contact.url.messenger");
    expect(types("join t.me/akshay")).toContain("contact.url.messenger");
  });

  it("flags shorteners without fetching them", () => {
    const found = detect("check bit.ly/abc123");
    const shortener = found.find((d) => d.type === "contact.url.shortener");
    expect(shortener).toBeDefined();
    expect(shortener!.evidence).toContain("not expanded");
  });

  it("never flags the first-party allowlist", () => {
    expect(hasType("see wayzyy.com/help", "contact.url")).toBe(false);
  });

  it("flags risky TLDs", () => {
    expect(types("go to cheapstay.xyz")).toContain("contact.url.risky_tld");
  });

  it("catches spoken URLs", () => {
    expect(hasType("instagram dot com slash akshay", "contact.url")).toBe(true);
  });

  it("extracts a phone number carried in a messenger link path", () => {
    // wa.me/919876543210 leaks a complete number; reporting only "a link was
    // shared" would let it through.
    const found = types("https://wa.me/919876543210");
    expect(found).toContain("contact.url.messenger");
    expect(found).toContain("contact.phone");
  });

  it("does not invent a phone from an ordinary link with digits", () => {
    expect(types("see wayzyy.com/listing/12345")).not.toContain("contact.phone");
  });

  it("flags mixed-script homographs", () => {
    // Cyrillic 'а' inside an otherwise-Latin hostname.
    expect(hasType("visit wаyzyy.com", "contact.url.homograph")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// upi
// ---------------------------------------------------------------------------

describe("upi detector", () => {
  it("catches a VPA on a known PSP handle", () => {
    expect(types("pay me at akshay@ybl")).toContain("payment.upi");
  });

  it("reports a phone-number VPA as contact AND payment", () => {
    const found = types("9876543210@paytm");
    expect(found).toContain("payment.upi");
    expect(found).toContain("contact.phone");
  });

  it("does not treat an email as a VPA", () => {
    expect(types("akshay@gmail.com")).not.toContain("payment.upi");
  });
});

// ---------------------------------------------------------------------------
// intent
// ---------------------------------------------------------------------------

describe("intent detector", () => {
  it("catches off-platform intent", () => {
    expect(types("lets book direct next time")).toContain("intent.offplatform");
    expect(types("can we take this offline")).toContain("intent.offplatform");
  });

  it("catches channel and contact intent", () => {
    expect(types("whatsapp me")).toContain("intent.channel");
    expect(types("call me")).toContain("intent.contact");
  });

  it("is leet-tolerant", () => {
    expect(types("c4ll me")).toContain("intent.contact");
    expect(types("wh4tsapp")).toContain("intent.channel");
  });

  it("catches hinglish variants", () => {
    expect(types("number de do")).toContain("intent.contact");
    expect(types("call karo")).toContain("intent.contact");
  });

  it("suppresses the 'call it a day' false positive", () => {
    expect(hasType("lets call it a day", "intent.")).toBe(false);
  });

  it("does not fire on substrings of ordinary words", () => {
    // "ig" must not match inside "big", "tg" not inside "hashtag".
    expect(hasType("the big room", "intent.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

describe("hostility detector", () => {
  it("tiers severity", () => {
    expect(types("this is nonsense")).toContain("safety.hostility.sev1");
    expect(types("you bastard")).toContain("safety.hostility.sev2");
    expect(types("i will kill you")).toContain("safety.hostility.sev3");
  });

  it("catches hinglish abuse", () => {
    expect(hasType("bakwas service", "safety.hostility")).toBe(true);
  });
});

describe("extortion detector — the founder's pet issue", () => {
  it("catches demand + conditional + leverage", () => {
    expect(types("give me a refund or i will leave a 1 star review")).toContain("safety.extortion");
  });

  it("catches the reordered hinglish form", () => {
    expect(hasType("paisa wapas karo warna bura review kar dunga", "safety.extortion")).toBe(true);
  });

  it("catches leverage-first phrasing", () => {
    expect(hasType("i will post about this on social media unless you refund", "safety.extortion")).toBe(
      true,
    );
  });

  it("catches implied extortion without an explicit conditional", () => {
    expect(hasType("refund me, i have already written the bad review", "safety.extortion")).toBe(true);
  });

  it("does NOT fire on ordinary review talk", () => {
    expect(hasType("i left you a great review, thanks!", "safety.extortion")).toBe(false);
    expect(hasType("could i get a refund for the extra night?", "safety.extortion")).toBe(false);
    expect(hasType("please read my review when you get a chance", "safety.extortion")).toBe(false);
  });
});

describe("scamlink detector", () => {
  it("fires on a link plus payment and urgency cues", () => {
    expect(hasType("pay the deposit right now at bit.ly/xyz123", "safety.scamlink")).toBe(true);
  });

  it("does not fire on a bare link", () => {
    expect(hasType("here is the place: cheapstay.xyz", "safety.scamlink")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hard negatives (SPEC §10) — the friction budget is 0.5%
// ---------------------------------------------------------------------------

describe("hard negatives stay clean", () => {
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
    "GST number is 27AAPFU0939F1ZV",
    "the gate code is 4455",
  ];

  for (const text of negatives) {
    it(`does not raise a contact/safety flag: "${text}"`, () => {
      const found = types(text).filter(
        (t) => t.startsWith("contact.") || t.startsWith("safety.") || t.startsWith("payment."),
      );
      expect(found).toEqual([]);
    });
  }
});

describe("handle detector does not read ordinary words as handles", () => {
  it("ignores verbs and connectives after a platform name", () => {
    // "whatsapp claiming" was matching as a platform-prefixed handle, which
    // flagged a guest reporting a scam.
    for (const text of [
      "someone messaged me on whatsapp claiming to be you",
      "they contacted me on instagram asking for money",
      "he sent a message on telegram saying he was the host",
    ]) {
      expect(hasType(text, "contact.handle"), text).toBe(false);
    }
  });

  it("still catches a real handle after a platform name", () => {
    expect(hasType("find me on instagram akshay_travels", "contact.handle")).toBe(true);
  });
});
