import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BellOff, BellRing, ChevronDown, ChevronRight, ExternalLink, Flame, Sparkles, TimerReset } from "lucide-react";
import { request, useApi, type AlertItem, type EventRow, type IncidentDetail as Detail, type Rule, type SuppressedRun } from "../lib/api";
import { ago, dateTime, day, duration, num, ordinal, time, timeSec } from "../lib/format";
import { useMeta } from "../lib/meta";
import { ChannelFrame, SlackMessage } from "../components/SlackMessage";
import { ErrorState, KindBadge, Panel, SeverityTag, SkeletonRows, StatePill, cx } from "../components/ui";

const RULE_UI: Record<Exclude<Rule, "quiet_window">, { label: string; Icon: typeof Flame }> = {
  first_occurrence: { label: "First occurrence", Icon: Sparkles },
  escalation: { label: "Escalation", Icon: Flame },
  window_expired: { label: "Quiet window expired", Icon: TimerReset },
};

function explain(a: AlertItem): string {
  if (a.rule === "first_occurrence") return `Never seen before, so it alerts straight away. Repeats are now held for ${duration(a.window_seconds)}.`;
  if (a.rule === "escalation")
    return `${ordinal(a.count)} occurrence reached an escalation threshold, so it alerts even inside the quiet window. ${num(a.suppressed)} suppressed since the previous alert.`;
  return `The ${duration(a.window_seconds)} quiet window had run out and it fired again, so the team is told it is still happening. ${num(a.suppressed)} suppressed since the previous alert.`;
}

function Run({ run, fingerprint }: { run: SuppressedRun; fingerprint: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setOpen((o) => !o);
    if (rows || open) return;
    try {
      const res = await request<{ events: EventRow[] }>(`/api/incidents/${encodeURIComponent(fingerprint)}/events?from_id=${run.from_id}&to_id=${run.to_id}&limit=200`);
      setRows(res.events);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const sameDay = day(run.from_ts) === day(run.to_ts);
  return (
    <li className="relative pl-9">
      <span className="absolute left-[9px] top-[9px] flex h-[14px] w-[14px] items-center justify-center rounded-full border border-line-strong bg-canvas" aria-hidden>
        <BellOff size={8} className="text-ink-3" />
      </span>
      <button onClick={toggle} aria-expanded={open} className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left hover:bg-sunken/70">
        <span className="text-[12.5px] text-ink-2">
          <span className="font-medium text-ink tnum">{num(run.n)}</span> {run.n === 1 ? "occurrence" : "occurrences"} suppressed
          <span className="text-ink-3"> · inside quiet window · </span>
          <span className="tnum text-ink-3">
            {run.n === 1 ? dateTime(run.from_ts) : `${dateTime(run.from_ts)} to ${sameDay ? time(run.to_ts) : dateTime(run.to_ts)}`}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-3 group-hover:text-ink-2">
          <span className="hidden whitespace-nowrap tnum min-[1400px]:inline">#{num(run.from_count)}{run.n > 1 && ` to #${num(run.to_count)}`}</span>
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        </span>
      </button>
      {open && (
        <div className="mb-2 mt-1 max-h-[220px] overflow-y-auto rounded-md border border-line bg-canvas">
          {error && <p className="px-3 py-2 text-crit">{error}</p>}
          {!rows && !error && <SkeletonRows rows={3} />}
          {rows && (
            <table className="w-full text-[12px]">
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="w-20 px-3 py-1 text-ink-3 tnum">#{num(e.count)}</td>
                    <td className="w-40 px-3 py-1 tnum">{day(e.ts)}, {timeSec(e.ts)}</td>
                    <td className="px-3 py-1 text-ink-2">Suppressed: {e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows && run.n > rows.length && <p className="border-t border-line px-3 py-1.5 text-[11.5px] text-ink-3">Showing the first {rows.length} of {num(run.n)}.</p>}
        </div>
      )}
    </li>
  );
}

function AlertRow({ a, selected, onSelect }: { a: AlertItem; selected: boolean; onSelect: () => void }) {
  const ui = RULE_UI[a.rule as keyof typeof RULE_UI];
  return (
    <li className="relative pl-9">
      <span className="absolute left-[5px] top-[11px] flex h-[22px] w-[22px] items-center justify-center rounded-full bg-accent text-on-accent ring-4 ring-surface" aria-hidden>
        <BellRing size={11} strokeWidth={2.4} />
      </span>
      <button
        onClick={onSelect}
        aria-pressed={selected}
        className={cx("w-full rounded-md border px-3 py-2 text-left transition-colors", selected ? "border-accent bg-accent-soft" : "border-line bg-sunken/60 hover:border-line-strong")}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold">Alert sent</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent-strong shadow-[inset_0_0_0_1px_var(--color-accent-line)]">
            <ui.Icon size={11} aria-hidden />
            {ui.label}{a.rule === "escalation" && ` at ${ordinal(a.count)}`}
          </span>
          <span className="ml-auto text-[12px] text-ink-2 tnum">{day(a.ts)}, {timeSec(a.ts)}</span>
          <span className="w-14 text-right text-[11.5px] text-ink-3 tnum">#{num(a.count)}</span>
        </div>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{explain(a)}</p>
      </button>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-[11.5px] font-medium text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-medium tnum">{children}</dd>
    </div>
  );
}

export default function IncidentDetail() {
  const fingerprint = useParams()["*"] ?? "";
  const [params, setParams] = useSearchParams();
  const { version } = useMeta();
  const { data, error, loading, reload } = useApi<Detail>(`/api/incidents/${encodeURIComponent(fingerprint)}?v=${version}`);
  const selected = params.get("alert") ? Number(params.get("alert")) : null;
  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const clicked = useRef(false);

  useEffect(() => {
    if (selected !== null && clicked.current) msgRefs.current[selected]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  if (error) return <ErrorState message={error === "no incident with that fingerprint" ? `No incident with fingerprint ${fingerprint}. It may have been cleared by a demo reset.` : error} onRetry={reload} />;
  if (!data) return loading ? <Panel><SkeletonRows rows={14} /></Panel> : null;

  const { incident: inc, timeline, deliveries } = data;
  const select = (id: number) => {
    clicked.current = true;
    setParams(selected === id ? {} : { alert: String(id) }, { replace: true });
  };
  const ratio = inc.alerts ? Math.round(inc.events / inc.alerts) : 0;

  return (
    <>
      <nav className="mb-3 flex items-center gap-1.5 text-[12.5px] text-ink-2" aria-label="Breadcrumb">
        <Link to="/incidents" className="hover:text-ink">Incidents</Link>
        <ChevronRight size={12} aria-hidden />
        <span className="font-mono text-[12px] text-ink-3">{inc.fingerprint}</span>
      </nav>

      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-snug tracking-[-0.01em]">{inc.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
            <StatePill state={inc.state} />
            <SeverityTag severity={inc.severity} />
            <KindBadge kind={inc.kind} label={inc.source_name} />
            <span>{inc.service}{inc.environment && ` (${inc.environment})`}</span>
            {inc.culprit && <span className="font-mono text-[12px]">{inc.culprit}</span>}
          </div>
        </div>
        {inc.url && (
          <a href={inc.url} target="_blank" rel="noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-sunken px-3 text-[12.5px] font-medium hover:bg-raised">
            Open in {inc.kind === "generic" ? "source" : inc.kind_label} <ExternalLink size={12} aria-hidden />
          </a>
        )}
      </header>

      <dl className="mt-4 grid grid-cols-6 divide-x divide-line rounded-lg border border-line bg-surface">
        <Fact label="Occurrences">{num(inc.events)}</Fact>
        <Fact label="Alerts sent"><span className="text-accent">{num(inc.alerts)}</span>{ratio > 1 && <span className="ml-1.5 text-[12px] font-normal text-ink-3">1 per {num(ratio)} events</span>}</Fact>
        <Fact label="Suppressed">{num(inc.suppressed)}</Fact>
        <Fact label="First seen">{dateTime(inc.first_seen)}</Fact>
        <Fact label="Last seen">{dateTime(inc.last_seen)} <span className="ml-1 text-[12px] font-normal text-ink-3">{ago(inc.last_seen, data.now)}</span></Fact>
        <Fact label="Quiet window"><Link to="/rules" className="hover:text-accent">{duration(inc.window_seconds)}</Link></Fact>
      </dl>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] items-start gap-5">
        <Panel title="Decision timeline" hint="Every occurrence, oldest first, with the rule that decided it. Select an alert to find its Slack message.">
          <ol className="relative space-y-1.5 px-4 py-4 before:absolute before:bottom-6 before:left-[31.5px] before:top-6 before:w-px before:bg-line-strong">
            {timeline.map((item) =>
              item.type === "alert" ? (
                <AlertRow key={item.event_id} a={item} selected={selected === item.event_id} onSelect={() => select(item.event_id)} />
              ) : (
                <Run key={`r${item.from_id}`} run={item} fingerprint={inc.fingerprint} />
              ),
            )}
          </ol>
        </Panel>

        <div className="sticky top-5 space-y-3">
          <ChannelFrame
            channel={data.channel}
            right={<span className="text-[12px] text-[#616061] tnum">{num(deliveries.length)} {deliveries.length === 1 ? "message" : "messages"} for {num(inc.events)} events</span>}
          >
            <div className="max-h-[calc(100vh-330px)] min-h-[300px] overflow-y-auto py-1.5">
              {deliveries.map((d) => (
                <div key={d.id} ref={(el) => { msgRefs.current[d.event_id] = el; }} onClick={() => select(d.event_id)} className="cursor-pointer">
                  <SlackMessage delivery={d} selected={selected === d.event_id} />
                </div>
              ))}
            </div>
          </ChannelFrame>
          <p className="text-[12px] leading-snug text-ink-3">
            Rendered from the exact Block Kit payload handed to the Slack client.{" "}
            {deliveries[0]?.mode === "outbox" ? "In demo mode the client writes to an in app outbox instead of the network." : "Delivered through your Slack incoming webhook."}
          </p>
          {inc.details && (
            <Panel title="Latest event details">
              <pre className="overflow-x-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12px] leading-relaxed text-ink-2">{inc.details}</pre>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
