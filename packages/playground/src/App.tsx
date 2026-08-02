import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { GROUP_LABELS, PRESETS, type Preset } from "./presets.js";
import { TIERS, resetConversation, resolvedTierIndex, runEngine, type TraceEntry } from "./engine.js";
import { normalize } from "@gatekeeper/core";
import type { BookingStage, SenderRole } from "@gatekeeper/core";

const CONVERSATION_ID = "playground";

export default function App(): JSX.Element {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<SenderRole>("guest");
  const [stage, setStage] = useState<BookingStage>("pre_booking");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? entries[entries.length - 1] ?? null,
    [entries, selectedId],
  );

  const send = useCallback(
    async (text: string, asRole = role, asStage = stage) => {
      const trimmed = text.trim();
      if (trimmed === "" || busy) return;

      setBusy(true);
      try {
        const entry = await runEngine(trimmed, asRole, asStage, CONVERSATION_ID);
        setEntries((prev) => [...prev, entry]);
        setSelectedId(entry.id);
        setDraft("");
      } finally {
        setBusy(false);
      }
    },
    [busy, role, stage],
  );

  const usePreset = useCallback(
    (preset: Preset) => {
      if (preset.role !== undefined) setRole(preset.role);
      if (preset.stage !== undefined) setStage(preset.stage);
      void send(preset.text, preset.role ?? role, preset.stage ?? stage);
    },
    [role, send, stage],
  );

  const reset = useCallback(() => {
    resetConversation();
    setEntries([]);
    setSelectedId(null);
  }, []);

  // Land on a worked example rather than an empty form. The first thing a
  // visitor should see is the engine taking a message apart — an empty state
  // wastes the one screen where the product has to explain itself.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void send(PRESETS[0]!.text, "guest", "pre_booking");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    const cost = entries.reduce((sum, e) => sum + e.result.cost_usd, 0);
    const blocked = entries.filter((e) => e.result.verdict !== "allow").length;
    const latencies = entries.map((e) => e.result.latency_ms).sort((a, b) => a - b);
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1]! : 0;
    return { cost, blocked, p95, count: entries.length };
  }, [entries]);

  const grouped = useMemo(() => {
    const map = new Map<Preset["group"], Preset[]>();
    for (const preset of PRESETS) {
      const list = map.get(preset.group) ?? [];
      list.push(preset);
      map.set(preset.group, list);
    }
    return [...map];
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="wordmark">
          Gate<span>keeper</span>
        </h1>
        <p className="tagline">
          Contact-evasion and safety checks for guest–host chat. Try to get something past it.
        </p>
        <div className="masthead-spacer" />
        <div className="masthead-stat">
          engine runs <b>in this tab</b> — no server
        </div>
      </header>

      <div className="columns">
        {/* ----------------------------------------------------- presets -- */}
        <aside className="col col-presets">
          <h2 className="col-title">Try one</h2>
          {grouped.map(([group, presets]) => (
            <div className="preset-group" key={group}>
              <h3 className="preset-group-title">{GROUP_LABELS[group]}</h3>
              {presets.map((preset) => (
                <button
                  className="preset"
                  key={preset.label}
                  onClick={() => usePreset(preset)}
                  disabled={busy}
                >
                  {preset.label}
                  <span className="preset-note">{preset.note}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* -------------------------------------------------------- chat -- */}
        <main className="col">
          <h2 className="col-title">Conversation</h2>

          <div className="controls">
            <div className="seg" role="group" aria-label="Sender">
              {(["guest", "host"] as const).map((r) => (
                <button key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
                  {r}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Booking stage">
              {(["pre_booking", "post_booking"] as const).map((s) => (
                <button key={s} aria-pressed={stage === s} onClick={() => setStage(s)}>
                  {s === "pre_booking" ? "before booking" : "after booking"}
                </button>
              ))}
            </div>
            <button className="reset" onClick={reset} disabled={entries.length === 0}>
              clear
            </button>
          </div>

          <div className="thread">
            {entries.length === 0 ? (
              <p className="empty">
                Send a message, or pick one on the left.
                <br />
                Every check runs here, in your browser, in under a millisecond.
              </p>
            ) : (
              entries.map((entry) => <Message key={entry.id} entry={entry} selected={entry.id === selected?.id} onSelect={setSelectedId} />)
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="Write a message…"
              aria-label="Message"
            />
            <button className="send" type="submit" disabled={busy || draft.trim() === ""}>
              Send
            </button>
          </form>
        </main>

        {/* ------------------------------------------------------- trace -- */}
        <section className="col">
          <h2 className="col-title">What the engine saw</h2>
          {selected === null ? (
            <p className="empty">Nothing checked yet.</p>
          ) : (
            <Trace entry={selected} />
          )}
        </section>
      </div>

      <footer className="footer">
        <span>
          <b>{totals.count}</b> checked
        </span>
        <span>
          <b>{totals.blocked}</b> stopped
        </span>
        <span>
          p95 <b>{fmtMs(totals.p95)}</b>
        </span>
        <span className="footer-cost">
          spent <b>${totals.cost.toFixed(4)}</b>
        </span>
        <span className="spacer" />
        <span>precision 1.000 · recall 0.997 · friction 0.00% over 2,075 labelled messages</span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- message -- */

function Message({
  entry,
  selected,
  onSelect,
}: {
  entry: TraceEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { action } = entry;
  const withheld = action.deliveredText === null;

  return (
    <article
      className="msg"
      data-verdict={entry.result.verdict}
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(entry.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(entry.id);
        }
      }}
    >
      <div className="msg-head">
        <span className="msg-role">{entry.role}</span>
        <span>{entry.stage === "pre_booking" ? "before booking" : "after booking"}</span>
        <span className="msg-time">{fmtMs(entry.result.latency_ms)}</span>
      </div>

      <div className={`msg-body${withheld ? " withheld" : action.action === "mask" ? " masked" : ""}`}>
        {withheld ? "Not delivered" : action.deliveredText}
      </div>

      {action.reason !== "" && <p className="msg-reason">{action.reason}</p>}
    </article>
  );
}

/* --------------------------------------------------------------- trace -- */

function Trace({ entry }: { entry: TraceEntry }): JSX.Element {
  const { result } = entry;
  const views = useMemo(() => normalize(entry.text), [entry.text]);
  const resolvedIndex = resolvedTierIndex(result);

  const contributions = Object.entries(
    (result.signals["contributions"] as Record<string, number> | undefined) ?? {},
  ).sort((a, b) => b[1] - a[1]);

  const maxContribution = Math.max(1, ...contributions.map(([, v]) => v));

  return (
    <>
      {/* signature: the tier ladder. The light stops where the message did. */}
      <div className="ladder" aria-label="Which tier decided">
        {TIERS.map((tier, index) => {
          const state = index < resolvedIndex ? "used" : index === resolvedIndex ? "resolved" : "unused";
          return (
            <div className="rung" key={tier.key} data-state={state}>
              <div className="rung-index">{index + 1}</div>
              <div className="rung-label">{tier.label}</div>
              {state === "resolved" && <div className="rung-bar" />}
            </div>
          );
        })}
      </div>

      <div className="verdict-bar">
        <span className="verdict-chip" data-v={result.verdict}>
          {result.verdict}
        </span>
        <span className="masthead-stat">
          decided at tier <b>{resolvedIndex + 1}</b>
        </span>
        <span className="verdict-meta">
          <b>{fmtMs(result.latency_ms)}</b> · <b>${result.cost_usd.toFixed(5)}</b>
        </span>
      </div>

      <Section title="Normalized views">
        <div className="views">
          <ViewRow name="raw" value={views.raw} />
          <ViewRow name="folded" value={views.folded} changed={views.folded !== views.raw.toLowerCase()} />
          <ViewRow name="denoised" value={views.denoised} changed={views.denoised !== views.folded} />
          <ViewRow name="digitized" value={views.digitized} changed={views.digitized !== views.denoised} />
        </div>
      </Section>

      {views.digitRuns.length > 0 && (
        <Section title="Numbers recovered">
          <div className="chips">
            {views.digitRuns.map((run, index) => (
              <span className="chip" data-kind="contact" key={index}>
                {run.digits}
                {run.mixedForm ? " · words+digits" : ""}
              </span>
            ))}
          </div>
        </Section>
      )}

      {result.categories.length > 0 && (
        <Section title="What was found">
          <div className="chips">
            {result.categories.map((category) => (
              <span className="chip" data-kind={category.split(".")[0]} key={category}>
                {category}
              </span>
            ))}
          </div>
        </Section>
      )}

      {contributions.length > 0 && (
        <Section title={`Score ${Number(result.signals["risk_score"] ?? 0).toFixed(2)}`}>
          <div className="bars">
            {contributions.map(([name, value]) => (
              <div className="bar-row" key={name}>
                <span className="bar-name">{name}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${(value / maxContribution) * 100}%` }} />
                </span>
                <span className="bar-value">{value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Signals">
        <div className="kv">
          <Kv label="noise digits" value={result.signals["noise_digits_removed"]} hot />
          <Kv label="zero-width" value={result.signals["zero_width_count"]} hot />
          <Kv label="homoglyphs" value={result.signals["confusables_folded"]} hot />
          <Kv label="odd tokens" value={result.signals["weird_tokens"]} hot />
          <Kv label="digit pressure" value={fmt(result.signals["digit_pressure"])} />
          <Kv label="intent hits" value={(result.signals["intent_hits"] as string[] | undefined)?.length ?? 0} />
        </div>
      </Section>

      {result.signals["merged_fragments"] !== undefined && (
        <Section title="Across messages">
          <div className="chips">
            <span className="chip" data-kind="safety">
              rebuilt {String(result.signals["merged_fragments"])} from{" "}
              {String(result.signals["merged_from_messages"])} messages
            </span>
          </div>
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="section">
      <h3 className="section-title">{title}</h3>
      {children}
    </div>
  );
}

function ViewRow({ name, value, changed }: { name: string; value: string; changed?: boolean }): JSX.Element {
  return (
    <div className="view-row" data-changed={changed === true}>
      <span className="view-name">{name}</span>
      <span className="view-value">{value === "" ? "—" : value}</span>
    </div>
  );
}

function Kv({ label, value, hot }: { label: string; value: unknown; hot?: boolean }): JSX.Element {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return (
    <div className="kv-item">
      <div className="kv-key">{label}</div>
      <div className="kv-val" data-hot={hot === true && numeric > 0}>
        {String(value ?? 0)}
      </div>
    </div>
  );
}

/**
 * Sub-0.01ms rounds to "0.00 ms", which reads as broken rather than fast.
 * Show real precision at the low end instead.
 */
function fmtMs(ms: number): string {
  if (ms >= 1) return `${ms.toFixed(2)} ms`;
  if (ms >= 0.01) return `${ms.toFixed(3)} ms`;
  return `${Math.max(1, Math.round(ms * 1000))} µs`;
}

function fmt(value: unknown): string {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "0";
}
