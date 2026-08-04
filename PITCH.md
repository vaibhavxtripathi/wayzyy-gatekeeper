# Gatekeeper — contact-evasion & chat safety for Wayzyy

**Live demo:** https://wayzyy-gatekeeper.vercel.app — type a message, watch the tier ladder decide it.

---

## TL;DR

**A five-tier cost-descending cascade for guest–host chat.** Each tier is cheaper and more certain than the one after it; a message stops at the first tier that can decide it. 91% never reach a model, and 99.97% never reach an LLM.

| | |
|---|---|
| **Precision / Recall** | 1.0000 / 0.9991 |
| **Friction** (legit blocked) | **0.00%** across 2,000 hard negatives |
| **p95 latency** | **~0.9 ms** (target ≤ 25 ms) |
| **Cost / 100k messages** | **$0.00** — 0.03% reach the LLM |
| **Tests** | 259, typecheck clean, 3,088 evaluations |

Both benchmark strings from your brief block correctly:

| Input | Verdict |
|---|---|
| `hi i a92m a121ksh35ay call me on nine eight 7 six zero` | **block** |
| `reach out at insta: akshay_98_76_five_four` | **block** |

**Three things worth your time:**

1. **The hard problem is friction, not detection.** Guest–host chat is full of digits that aren't phone numbers — prices, PINs, flight codes, guest counts. Catching `nine eight 7 six zero` is easy; catching it *without* blocking `₹98,765 for 5 nights` is the actual engineering. I optimised for precision because a blocked innocent message costs more than a leaked number. (§1, §4)

2. **Safety is scored separately from contact risk**, so post-booking can relax contact rules without relaxing hostility or extortion. Reporting a scam is distinguished from committing one; asking about an address is distinguished from sharing one. (§3)

3. **My benchmark said precision 1.0000 and 0.00% friction — and it was structurally wrong.** All 1,000 hard negatives ran through a code path where the bug I had *couldn't* occur. Manual testing caught it; the dashboard never would have. Eight defects were hiding behind that green. **If you read one section, read §5.**

**Honest caveat:** the corpus is synthetic. Precision 1.0000 means the engine handles the evasions I thought to write down — a measure of my imagination as much as its coverage. (§6)

---

## 1. The problem, stated precisely

Your brief names the real failure mode: *"Airbnb's current system often locks innocent messages while letting clever digit-splitting slip through."*

That is two failures with opposite causes, and most systems trade one for the other:

- **Leaks** — evasions that walk past a regex (`a121ksh35ay`, `nine eight 7 six zero`)
- **Friction** — innocent messages blocked (`₹98,765 for 5 nights`, `flight 6E 2134`, `PIN 403507`)

A guest-host chat is *full* of digits that are not phone numbers. Any system that treats "contains digits" as suspicious will block a booking conversation. The engineering problem is separating **obfuscation** from **ordinary numeric content** — and doing it fast enough and cheap enough to run on every message.

---

## 2. Architecture — a cost-descending cascade

Five tiers. Each is cheaper and more certain than the one after it. A message stops at the first tier that can decide it.

```
Tier 1  Normalize      multi-view: fold, denoise, deleet, digit-runs   free   ~0.1ms
Tier 2  Detectors      10 deterministic detectors + lexicons           free   ~0.1ms
Tier 3  Risk           weighted score + relationship state             free   ~0.2ms
Tier 4  Classifier     logistic regression, 3.2k weights               free   ~0.3ms
Tier 5  LLM            Groq llama-3.1-8b, cached, 1200ms timeout   $0.0000208
```

**Measured distribution:** 53.66% resolve at Tier 1, 37.34% at Tier 3, 9.00% at Tier 4, **0.03% reach the LLM.**

The design principle: *spend nothing on the easy cases.* A valid phone number is unambiguous — it should never cost an LLM call. The LLM exists only for genuine ambiguity, which is 3 messages in 10,000.

### Why a cascade rather than one model

An LLM on every message is ~$2/100k and 200–400ms. A pure regex is free and fast but brittle. The cascade gets the regex's cost and the LLM's judgment, because **the tiers disagree in useful ways** — and the cheap tiers are frequently *more* accurate:

> `llama-3.1-8b` classifies PIN code `403507` as a contact leak. It's an explicit hard negative. Tiers 1–3 resolve it at risk 0 and never consult the LLM. A test asserts Tier 5 is never called for messages the cheap tiers allow.

### Tier 1 — multi-view normalization

The key idea. One message becomes several views, and detectors run on whichever view exposes their signal:

| View | Purpose | Example |
|---|---|---|
| `folded` | Unicode confusables → ASCII | `𝟗𝟖𝟕𝟔𝟓` → `98765` |
| `denoised` | strip separators and filler | `9-8-7 6 5` → `98765` |
| `deleet` | leet → letters | `c4ll m3` → `call me` |
| `digitRuns` | merged digit sequences with source spans | `nine eight 7` → `987` |

Word-numbers are resolved in **English, Hinglish and Devanagari** (`nine`, `nau`, `नौ`). Spans are tracked back to the raw string so masking redacts the right characters.

### Tier 3 — relationship state

Per-conversation, not per-message. A number split across turns (`98765` … `43210`) is invisible to any single-message detector. Tier 3 buffers digit fragments and merges them inside a 30-minute window.

This is also where the subtlest bugs live — see §5.

---

## 3. Safety moderation

Your form asks about non-contact safety explicitly. Scored **separately** from contact risk, because the stage modifier must not relax it:

| Family | Approach |
|---|---|
| **Hostility** | 4 severity bands. Coarse register (`shitty flight`) scores below the allow band; the same word aimed at a person (`your shitty attitude`) is promoted to abuse. Self-censored spellings (`f*ck`) matched by shape, not by enumerating variants. |
| **Extortion** | Three slot families — DEMAND × CONDITIONAL × LEVERAGE — scored by co-occurrence and proximity, not one brittle regex. Catches reordered and Hinglish variants: *"warna main bura review kar dunga, paisa wapas karo"*. |
| **Scam links** | URL detection × (payment ∣ urgency ∣ too-good pricing) cues. |

**Post-booking relaxes contact rules but never safety.** A host must be able to send a gate code to a confirmed guest; nobody needs to send a threat.

Two distinctions that took real work:

- **Reporting a scam is not committing one.** *"someone messaged me on WhatsApp claiming to be you"* is the message a platform most wants delivered. It is suppressed by third-party framing.
- **Asking is not sharing.** *"what is the exact address?"* is a question; *"the address is…"* is a disclosure.

---

## 4. Trade-offs I made deliberately

**Latency vs accuracy.** The cascade's whole shape is this trade. p95 is under a millisecond because 91% of traffic never reaches a model. I could add a transformer at Tier 4 for better generalization — the interface is designed for it — but it would cost ~20ms and the corpus does not currently justify it.

**Precision vs recall — I chose precision.** Friction is the more expensive failure. A blocked innocent message is a support ticket and a churned user; a leaked number is one lost commission. So partials never auto-block, questions are exempted, and carryover can corroborate but never convict.

**Fail closed pre-booking, open post-booking.** Contact fraud lives before the booking. After it, the pair has legitimate reasons to exchange logistics, and blocking costs more than it saves.

**Masking over blocking.** `my number is 9876543210` delivers as `my number is ••••••••••`. The conversation survives; the payload does not.

**Oracle resistance.** Blocked messages return a generic reason. Telling an attacker *which* pattern tripped turns the engine into a free oracle they can grind against.

**What I did not build:** IDN homograph detection beyond the common set, image/OCR contact sharing, and voice. All are real evasion routes and all are out of scope for the time available. Named in the README as non-goals rather than left implied.

---

## 5. The part I would actually want to be judged on

I built a benchmark. It reported **precision 1.0000, 0.00% friction**. Every target green.

Then I used the playground by hand, and it blocked `thanks, see you on the 9th!`

The dashboard was wrong. Not slightly — **structurally**. All 1,000 hard negatives were scored through the stateless code path, which hardcodes `digitPressure: 0`. The friction metric was measuring a path on which the bug *could not occur*. It was not a wrong number; it was a number answering a different question than the one it appeared to answer.

Eight defects were hiding behind it. The three worth naming:

**Unbounded relationship state.** `digitPressure` counted raw digits and was added linearly with no ceiling. Ten turns of ordinary booking chat — dates, prices, guest counts — reached 11.9 against a block band of 8.0. Every subsequent message was convicted by arithmetic, whatever it said. *Fix: the term saturates below the allow band, so carryover can corroborate but never decide.*

**Target leakage in Tier 4.** `riskScore` was a classifier feature. But Tier 4 only ever sees messages Tier 3 escalated, so that feature was bounded below by the band on every training row — the model learned a weight of 4.86 against a bias of +1.30 and saturated the sigmoid. It scored **p=1.0000 on "thanks, see you on the 14th"** and blocked 250 of 256 band messages by reflex. Its reported 100% accuracy was the tautology *"escalated ⇒ violation."* *Fix: feature removed, training pool balanced per label (was 250:6).*

**A missing word.** The hostility lexicon had `cunt`, `bitch`, `madarchod` — and not one form of the most common English profanity. `grep -r` returned zero hits across the engine *and the corpus*. So `fuck off` was delivered as "Nothing concerning found" while `you people are useless` blocked. Because the corpus omitted it too, the reported **100% hostility recall was measured against a corpus that never tested for it.**

**What I changed structurally:** hard negatives are now replayed as *conversations*, not just single messages, so accumulated state is exercised the way production exercises it. That harness change immediately caught a ninth bug I had not seen by hand — two flight codes (`G81104`, `G89892`) merging into `8110489892`, a valid mobile nobody sent.

Every fix is verified load-bearing: I reverted each one and confirmed a specific test fails.

The transferable lesson, and the reason this section exists: **a metric that cannot fail is not evidence.** I would rather show you the bug I found in my own dashboard than the dashboard.

---

## 6. Results

Reproduced by `pnpm bench` on every run. 2,088 labelled messages, 3,088 evaluations.

| Metric | Measured | Target |
|---|---|---|
| Precision | **1.0000** | ≥ 0.99 |
| Recall | **0.9991** | ≥ 0.97 |
| Friction (legit blocked) | **0.00%** | ≤ 0.50% |
| p95 latency | **0.90 ms** | ≤ 25 ms |
| Reaches Tier 5 | **0.03%** | ≤ 2% |
| Cost / 100k | **$0.0000** | ≤ $0.15 |
| Resolved ≤ Tier 3 | **91.00%** | ≥ 92% |

`confusion: tp 1087 · fp 0 · tn 2000 · fn 1`

**259 tests. Typecheck clean across three packages.**

**21 of 22 evasion techniques at 100% recall** — noise injection, mixed-form, word-numbers (en/hi/devanagari), leet, unicode confusables, zero-width, separators, digit-splitting, spelled-email, handle-smuggling, UPI, spoken-URL, shorteners, pure-intent, extortion, hostility, scam-link, prompt-injection.

### The last target, left failing

`resolved ≤ tier 3` reads 91.00% against a 92% target. I could pass it by widening the allow band from 3.0 — one number in one config file. That trades real recall for a cosmetic metric, so **I left it failing and wrote down why.**

### What these numbers do not mean

The corpus is synthetic — deterministic and labelled by technique, but generated, not collected. **Precision 1.0000 means the engine handles the evasions I thought to write down.** It is a measure of my imagination as much as the engine's coverage. Real traffic will contain phrasings the corpus does not, and the honest expectation is that precision drops on contact with it.

That is also why the cascade is built to be tuned rather than retrained: weights and bands live in `config/thresholds.json`, hot-loadable, no redeploy.

---

## 7. Production readiness

- **`POST /v1/moderate`**, `/v1/health`, `/v1/stats` — Fastify, typed request/response.
- **`core` has zero I/O.** No fs, no network. That is why the same engine runs in-browser on the live demo with no backend — and why it is trivially testable.
- **Session store is an interface.** In-memory for the demo; Redis drops in without touching the engine.
- **The LLM transport is injected**, so Tier 5 is fully unit-testable with no network.
- **Hot-tunable config** via `THRESHOLDS_PATH`.
- **Rate limiting** per sender per conversation, anti threshold-probing.
- **Async mode** — deliver-then-redact for zero user-facing latency.

**Scaling:** stateless per message except the session store, so it scales horizontally. At 100k messages/day the projected LLM spend is **$0.00** — 0.03% of traffic × $0.0000208.

---

## 8. Links

| | |
|---|---|
| **Live demo** | https://wayzyy-gatekeeper.vercel.app |
| **Repo** | `github.com/vaibhavxtripathi/wayzyy-gatekeeper` *(private — happy to add reviewers)* |
| **Video walkthrough** | *(add before submitting)* |

`README.md` covers setup; `REPORT.md` is the full engineering log including all 25 defects found and fixed.

---

## 9. What I would do next

1. **Replace the synthetic corpus with real traffic.** Everything above is bounded by this. Shadow-mode against live chat, measure disagreement, tune bands on real distributions.
2. **A stronger red team.** The current attacker (`llama-3.1-8b`) repeats itself by round three. It found a real gap — the lexicon covered *offering* contact info but not *requesting* it, which 9 of 20 attacks exploited — but the sample is small and that run predates the current build.
3. **Calibrate Tier 3 weights against real traffic.** They are hand-tuned to this corpus — a starting point, not a finished calibration.
4. **Distilled transformer at Tier 4**, behind the existing interface, once there is real data to justify the latency.
5. **Image/OCR contact sharing** — a screenshot of a phone number defeats every text pipeline including this one.
