import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useApi, type Rule, type Stats } from "../lib/api";
import { ago, dateTime, num } from "../lib/format";
import { useMeta } from "../lib/meta";
import { TimelineChart } from "../components/TimelineChart";
import { ErrorState, KindBadge, PageHeader, Panel, Segmented, SeverityDot, SkeletonRows, td, tdNum, th, thNum } from "../components/ui";

const RANGE_LABEL: Record<string, string> = { "24h": "24 hours", "3d": "3 days", "7d": "7 days" };

const SENT_BECAUSE: { rule: Rule; label: string; explain: string }[] = [
  { rule: "first_occurrence", label: "First occurrence", explain: "A problem nobody has seen before" },
  { rule: "window_expired", label: "Still happening", explain: "Quiet window ran out and it fired again" },
  { rule: "escalation", label: "Escalation", explain: "Crossed an occurrence threshold" },
];

// part-to-whole steps of the accent, solid colours so each keeps 3:1 on the dark surface
const STEP = ["bg-accent", "bg-accent-step-2", "bg-accent-step-3"];

function Kpi({ label, value, sub, foot }: { label: string; value: string; sub: string; foot: string }) {
  return (
    <div className="flex flex-col px-5 py-4">
      <p className="text-[12px] font-medium text-ink-2">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em] tnum">{value}</p>
      <p className="mt-1.5 text-[12px] text-ink-3">{sub}</p>
      <p className="mt-auto border-t border-line pt-2 text-[12px] text-ink-2 tnum">{foot}</p>
    </div>
  );
}

export default function Overview() {
  const [params, setParams] = useSearchParams();
  const range = params.get("range") && RANGE_LABEL[params.get("range")!] ? params.get("range")! : "7d";
  const { version } = useMeta();
  const { data, error, loading, reload } = useApi<Stats>(`/api/stats?range=${range}&v=${version}`);

  const t = data?.totals;
  const perAlert = t && t.alerts ? Math.round(t.events / t.alerts) : null;
  const days = data ? (data.until - data.since) / 86400 : 1;
  const perDay = (n: number) => `${num(Math.round(n / days))} a day on average`;
  const sentTotal = data ? SENT_BECAUSE.reduce((s, r) => s + (data.rules_fired[r.rule] ?? 0), 0) : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        sub="Every failure from your apps and automations lands here first. Your team only hears about the ones that are new, still happening, or getting worse."
        actions={
          <Segmented
            label="Time range"
            value={range}
            onChange={(v) => setParams(v === "7d" ? {} : { range: v }, { replace: true })}
            options={Object.entries(RANGE_LABEL).map(([value, label]) => ({ value, label: `Last ${label}` }))}
          />
        }
      />

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <Panel><SkeletonRows rows={10} /></Panel>}

      {data && t && (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <section className="grid grid-cols-[1.35fr_1fr_1fr_1fr] divide-x divide-line rounded-lg border border-line bg-surface">
            <div className="px-5 py-4">
              <p className="text-[12px] font-medium text-ink-2">Noise reduction</p>
              <div className="mt-1 flex items-baseline gap-3">
                <p className="text-[40px] font-semibold leading-none tracking-[-0.03em] text-accent tnum">
                  {t.reduction_pct === null ? "n/a" : `${t.reduction_pct.toFixed(1)}%`}
                </p>
                <p className="text-[12.5px] leading-snug text-ink-2">
                  fewer Slack messages
                  <br />
                  than failures received
                </p>
              </div>
              <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-noise-soft" aria-hidden>
                <div className="bg-accent" style={{ width: `${t.events ? Math.max(1.5, (100 * t.alerts) / t.events) : 0}%` }} />
              </div>
              <p className="mt-1.5 text-[12px] text-ink-3">
                {perAlert ? `1 message for every ${num(perAlert)} events, across ${num(t.incidents)} distinct incidents` : "No events in this range"}
              </p>
            </div>
            <Kpi label="Events received" value={num(t.events)} sub="Webhook calls accepted from all sources" foot={perDay(t.events)} />
            <Kpi label="Alerts sent to Slack" value={num(t.alerts)} sub="Messages your team actually saw" foot={perDay(t.alerts)} />
            <Kpi label="Suppressed" value={num(t.suppressed)} sub="Repeats held back, still counted" foot={t.alerts ? `${(t.suppressed / t.alerts).toFixed(1)} held back for every alert sent` : "Nothing sent yet"} />
          </section>

          <Panel
            className="mt-5"
            title="Events received vs alerts sent"
            hint={`${dateTime(data.since)} to ${dateTime(data.until)}, in ${data.step / 3600} hour buckets. Both lines share one axis: the gap is the noise your channel never saw.`}
            right={
              <div className="flex items-center gap-4 text-[12px] text-ink-2">
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-noise" />Events received</span>
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-accent" />Alerts sent</span>
              </div>
            }
          >
            <div className="px-4 pb-3 pt-4">
              {t.events === 0 ? (
                <p className="py-16 text-center text-ink-2">No events in this range yet. Send a test event from the Sources page.</p>
              ) : (
                <TimelineChart buckets={data.buckets} step={data.step} />
              )}
            </div>
          </Panel>

          <div className="mt-5 grid grid-cols-[1.45fr_1fr] gap-5">
            <Panel
              title="Noisiest incidents"
              hint="Ranked by events received in this range"
              right={<Link to="/incidents" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline">All incidents <ArrowRight size={12} aria-hidden /></Link>}
            >
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line">
                    <th className={th}>Incident</th>
                    <th className={th}>Source</th>
                    <th className={thNum}>Events</th>
                    <th className={thNum}>Alerts</th>
                    <th className={thNum}>Held back</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_noisy.map((r) => (
                    <tr key={r.fingerprint} className="border-b border-line last:border-0 hover:bg-sunken">
                      <td className={`${td} max-w-0 w-full`}>
                        <Link to={`/incidents/${encodeURIComponent(r.fingerprint)}`} className="flex items-center gap-2 hover:text-accent">
                          <SeverityDot severity={r.severity} />
                          <span className="truncate font-medium">{r.title}</span>
                        </Link>
                        <p className="truncate pl-4 text-[12px] text-ink-3">{r.service}</p>
                      </td>
                      <td className={`${td} whitespace-nowrap`}><KindBadge kind={r.kind} label={r.kind_label} /></td>
                      <td className={tdNum}>{num(r.events)}</td>
                      <td className={`${tdNum} font-medium`}>{num(r.alerts)}</td>
                      <td className={`${tdNum} text-ink-2`}>{r.events ? `${((100 * r.suppressed) / r.events).toFixed(1)}%` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div className="space-y-5">
              <Panel title="Sources" hint="Where failures come from" right={<Link to="/sources" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline">Manage <ArrowRight size={12} aria-hidden /></Link>}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={th}>Source</th>
                      <th className={thNum}>Events</th>
                      <th className={thNum}>Alerts</th>
                      <th className={thNum}>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.id} className="border-b border-line last:border-0">
                        <td className={td}>
                          <Link to={`/incidents?source=${s.id}`} className="font-medium hover:text-accent">{s.name}</Link>
                          <span className="ml-2 text-[12px] text-ink-3">{s.kind_label}</span>
                        </td>
                        <td className={tdNum}>{num(s.events)}</td>
                        <td className={`${tdNum} font-medium`}>{num(s.alerts)}</td>
                        <td className={`${tdNum} text-ink-2`}>{s.last_seen ? ago(s.last_seen, data.now) : "never"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Why alerts were sent" hint="The rule behind each message in this range">
                <div className="px-4 py-3">
                  <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                    {SENT_BECAUSE.map((r, i) => (
                      <div key={r.rule} className={STEP[i]} style={{ flex: data.rules_fired[r.rule] ?? 0 }} />
                    ))}
                  </div>
                  <dl className="mt-3 space-y-2">
                    {SENT_BECAUSE.map((r, i) => (
                      <div key={r.rule} className="flex items-baseline justify-between gap-3">
                        <dt className="flex items-baseline gap-2">
                          <span className={`h-2 w-2 shrink-0 translate-y-[-1px] rounded-sm ${STEP[i]}`} aria-hidden />
                          <span className="font-medium">{r.label}</span>
                          <span className="text-[12px] text-ink-3">{r.explain}</span>
                        </dt>
                        <dd className="tnum font-medium">
                          {num(data.rules_fired[r.rule] ?? 0)}
                          <span className="ml-1.5 inline-block w-9 text-right text-[12px] font-normal text-ink-3">
                            {sentTotal ? `${Math.round((100 * (data.rules_fired[r.rule] ?? 0)) / sentTotal)}%` : ""}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </Panel>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
