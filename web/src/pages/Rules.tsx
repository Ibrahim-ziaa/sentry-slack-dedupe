import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Undo2 } from "lucide-react";
import { sendJson, useApi, type RuleSet, type RulesPreview } from "../lib/api";
import { duration, num, ordinal } from "../lib/format";
import { useMeta } from "../lib/meta";
import { Button, ErrorState, PageHeader, Panel, SkeletonRows, cx, th, thNum, td, tdNum } from "../components/ui";

interface RulesData {
  rules: RuleSet;
  sources: { id: string; name: string }[];
}

const inputCls = "h-8 rounded-md border border-line-strong bg-sunken px-2 text-[12.5px] text-ink placeholder:text-ink-3 tnum";

function WindowInput({ seconds, onChange, id }: { seconds: number; onChange: (s: number) => void; id?: string }) {
  const unit = seconds % 3600 === 0 ? 3600 : 60;
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        id={id}
        type="number"
        min={1}
        value={seconds / unit}
        onChange={(e) => onChange(Math.max(1, Math.round(Number(e.target.value) || 1)) * unit)}
        className={cx(inputCls, "w-[72px]")}
      />
      <select aria-label="Unit" value={unit} onChange={(e) => onChange(Math.max(1, Math.round(seconds / unit)) * Number(e.target.value))} className={inputCls}>
        <option value={60}>{seconds === 60 ? "minute" : "minutes"}</option>
        <option value={3600}>{seconds === 3600 ? "hour" : "hours"}</option>
      </select>
    </span>
  );
}

function ThresholdInput({ value, onChange, id }: { value: number[]; onChange: (v: number[]) => void; id?: string }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText((t) => (parse(t).join() === value.join() ? t : value.join(", "))), [value]);
  return (
    <input
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
      placeholder="10, 100, 1000"
      className={cx(inputCls, "w-[180px]")}
    />
  );
}

const parse = (text: string) =>
  [...new Set(text.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 2))].sort((a, b) => a - b).slice(0, 6);

export default function Rules() {
  const { version, bump } = useMeta();
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi<RulesData>(`/api/rules?v=${version}`);
  const [draft, setDraft] = useState<RuleSet | null>(null);
  const [preview, setPreview] = useState<RulesPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = structuredClone(data.rules);
    // ?window=<seconds> opens the page with a what-if already typed in, so a preview can be shared as a link
    const whatIf = Number(params.get("window"));
    if (Number.isInteger(whatIf) && whatIf >= 60) next.window_seconds = whatIf;
    setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const dirty = useMemo(() => Boolean(data && draft && JSON.stringify(data.rules) !== JSON.stringify(draft)), [data, draft]);

  useEffect(() => {
    if (!draft) return;
    const handle = setTimeout(() => {
      sendJson<RulesPreview>("/api/rules/preview", "POST", draft)
        .then((p) => {
          setPreview(p);
          setSaveError(null);
        })
        .catch((e: Error) => setSaveError(e.message));
    }, 250);
    return () => clearTimeout(handle);
  }, [draft, version]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data || !draft) return loading ? <Panel><SkeletonRows rows={10} /></Panel> : null;

  const patch = (p: Partial<RuleSet>) => {
    setSaved(false);
    setDraft({ ...draft, ...p });
  };
  const setOverride = (id: string, key: "window_seconds" | "escalate_at", value: number | number[] | undefined) => {
    const current = { ...(draft.overrides[id] ?? {}) } as Record<string, unknown>;
    if (value === undefined) delete current[key];
    else current[key] = value;
    const overrides = { ...draft.overrides };
    if (Object.keys(current).length) overrides[id] = current;
    else delete overrides[id];
    patch({ overrides });
  };

  async function save() {
    setSaving(true);
    try {
      await sendJson("/api/rules", "PUT", draft);
      setSaved(true);
      bump();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const delta = preview ? preview.proposed_alerts - preview.current_alerts : 0;

  return (
    <>
      <PageHeader
        title="Rules"
        sub="Four rules decide every event, in this order. They are the same for every source unless you override them below."
        actions={
          <>
            {saved && !dirty && <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ok"><Check size={14} aria-hidden /> Saved. New events use these rules.</span>}
            <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(structuredClone(data.rules))}><Undo2 size={13} aria-hidden /> Discard</Button>
            <Button variant="primary" disabled={!dirty || saving} onClick={save}>{saving ? "Saving" : "Save rules"}</Button>
          </>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-5">
        <div className="space-y-5">
          <Panel title="How an event is decided">
            <ol className="divide-y divide-line">
              <li className="grid grid-cols-[28px_1fr] gap-x-3 px-4 py-3.5">
                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-2">1</span>
                <div>
                  <p className="font-semibold">First occurrence always alerts</p>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">A failure nobody has seen before goes to Slack immediately. Failures are matched by fingerprint: the Sentry issue, the n8n workflow and failing node, or the service and title of a custom event.</p>
                </div>
              </li>
              <li className="grid grid-cols-[28px_1fr] gap-x-3 px-4 py-3.5">
                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-2">2</span>
                <div>
                  <label htmlFor="window" className="font-semibold">Repeats stay quiet for</label>
                  <span className="ml-3"><WindowInput id="window" seconds={draft.window_seconds} onChange={(s) => patch({ window_seconds: s })} /></span>
                  <p className="mt-1.5 text-[12.5px] text-ink-2">After an alert, the same failure is counted but not posted again until this quiet window runs out. Shorter means more reminders, longer means a calmer channel.</p>
                </div>
              </li>
              <li className="grid grid-cols-[28px_1fr] gap-x-3 px-4 py-3.5">
                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-2">3</span>
                <div>
                  <label htmlFor="thresholds" className="font-semibold">Escalate at occurrence</label>
                  <span className="ml-3"><ThresholdInput id="thresholds" value={draft.escalate_at} onChange={(v) => patch({ escalate_at: v })} /></span>
                  <p className="mt-1.5 text-[12.5px] text-ink-2">
                    A failure that keeps firing breaks through the quiet window{draft.escalate_at.length ? ` on its ${draft.escalate_at.map(ordinal).join(", ")} occurrence` : ""}, with the running count, so a hot bug cannot hide behind the dedupe.
                    {draft.escalate_at.length === 0 && " No thresholds set: escalation is off."}
                  </p>
                </div>
              </li>
              <li className="grid grid-cols-[28px_1fr] gap-x-3 px-4 py-3.5">
                <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-2">4</span>
                <div>
                  <p className="font-semibold">Still happening after the window: alert again, with the count</p>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">The next occurrence after {duration(draft.window_seconds)} of quiet posts a fresh message that says how many repeats were suppressed in between.</p>
                </div>
              </li>
            </ol>
          </Panel>

          <Panel title="Per source overrides" hint="Some sources deserve different patience. Scheduled automations fail on a cadence, so an hourly reminder is just noise.">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>Source</th>
                  <th className={th}>Quiet window</th>
                  <th className={th}>Escalation thresholds</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => {
                  const o = draft.overrides[s.id] ?? {};
                  return (
                    <tr key={s.id} className="border-b border-line last:border-0">
                      <td className={`${td} font-medium`}>
                        {s.name}
                        <span className="ml-2 font-mono text-[11.5px] font-normal text-ink-3">/hooks/{s.id}</span>
                      </td>
                      <td className={td}>
                        {o.window_seconds !== undefined ? (
                          <span className="inline-flex items-center gap-2">
                            <WindowInput seconds={o.window_seconds} onChange={(v) => setOverride(s.id, "window_seconds", v)} />
                            <button onClick={() => setOverride(s.id, "window_seconds", undefined)} className="text-[12px] text-ink-3 hover:text-ink">Use default</button>
                          </span>
                        ) : (
                          <span className="text-ink-2">
                            Default ({duration(draft.window_seconds)})
                            <button onClick={() => setOverride(s.id, "window_seconds", draft.window_seconds)} className="ml-2 text-[12px] font-medium text-accent hover:underline">Override</button>
                          </span>
                        )}
                      </td>
                      <td className={td}>
                        {o.escalate_at !== undefined ? (
                          <span className="inline-flex items-center gap-2">
                            <ThresholdInput value={o.escalate_at} onChange={(v) => setOverride(s.id, "escalate_at", v)} />
                            <button onClick={() => setOverride(s.id, "escalate_at", undefined)} className="text-[12px] text-ink-3 hover:text-ink">Use default</button>
                          </span>
                        ) : (
                          <span className="text-ink-2">
                            Default ({draft.escalate_at.join(", ") || "off"})
                            <button onClick={() => setOverride(s.id, "escalate_at", [...draft.escalate_at])} className="ml-2 text-[12px] font-medium text-accent hover:underline">Override</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </div>

        <Panel
          className="sticky top-5"
          title="Impact on your real traffic"
          hint={preview ? `All ${num(preview.events)} stored events replayed through the dedupe engine, once per rule set.` : "Replaying stored events"}
        >
          {saveError && <p className="border-b border-line bg-crit-soft px-4 py-2 text-[12.5px] text-crit">{saveError}</p>}
          {!preview ? (
            <SkeletonRows rows={6} />
          ) : (
            <>
              <div className="grid grid-cols-2 divide-x divide-line border-b border-line">
                <div className="px-4 py-3">
                  <p className="text-[12px] text-ink-2">Saved rules</p>
                  <p className="mt-0.5 text-[24px] font-semibold leading-tight tnum">{num(preview.current_alerts)}</p>
                  <p className="text-[12px] text-ink-3">alerts</p>
                </div>
                <div className={cx("px-4 py-3", dirty && "bg-accent-soft/50")}>
                  <p className="text-[12px] text-ink-2">{dirty ? "With your changes" : "No unsaved changes"}</p>
                  <p className="mt-0.5 text-[24px] font-semibold leading-tight text-accent tnum">{num(preview.proposed_alerts)}</p>
                  <p className="text-[12px] text-ink-3">
                    alerts{dirty && delta !== 0 && <span className="ml-1 font-medium text-ink-2">({delta > 0 ? "+" : ""}{num(delta)})</span>}
                  </p>
                </div>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line">
                    <th className={th}>Source</th>
                    <th className={thNum}>Events</th>
                    <th className={thNum}>Saved</th>
                    <th className={thNum}>{dirty ? "Changed" : "Now"}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.by_source.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <td className={td}>{data.sources.find((s) => s.id === r.id)?.name ?? r.id}</td>
                      <td className={`${tdNum} text-ink-2`}>{num(r.events)}</td>
                      <td className={tdNum}>{num(r.current_alerts)}</td>
                      <td className={cx(tdNum, "font-medium", r.proposed_alerts !== r.current_alerts && "text-accent")}>{num(r.proposed_alerts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-line px-4 py-2.5 text-[12px] leading-snug text-ink-3">
                Change a value and this updates before you save. Saving affects new events only. History is never rewritten.
              </p>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
