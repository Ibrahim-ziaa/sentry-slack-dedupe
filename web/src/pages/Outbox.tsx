import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useApi, type Delivery, type Stats } from "../lib/api";
import { day, num, RULE_LABEL, weekday } from "../lib/format";
import { useMeta } from "../lib/meta";
import { ChannelFrame, SlackMessage } from "../components/SlackMessage";
import { EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, td, tdNum, th, thNum } from "../components/ui";

interface OutboxData {
  channel: string;
  delivery: "outbox" | "slack";
  total: number;
  messages: Delivery[];
}

export default function Outbox() {
  const { version } = useMeta();
  const { data, error, loading, reload } = useApi<OutboxData>(`/api/outbox?limit=60&v=${version}`);
  const { data: stats } = useApi<Stats>(`/api/stats?range=7d&v=${version}`);

  const perDay = useMemo(() => {
    const days = new Map<string, { t: number; events: number; alerts: number }>();
    stats?.buckets.forEach((b) => {
      const key = day(b.t);
      const row = days.get(key) ?? { t: b.t, events: 0, alerts: 0 };
      row.events += b.events;
      row.alerts += b.alerts;
      days.set(key, row);
    });
    return [...days.values()].filter((d) => d.events > 0).reverse();
  }, [stats]);
  const maxEvents = Math.max(1, ...perDay.map((d) => d.events));

  // group the feed under day dividers, the way a chat channel does
  const groups = useMemo(() => {
    const out: { label: string; items: Delivery[] }[] = [];
    data?.messages.forEach((m) => {
      const label = `${weekday(m.ts)}, ${day(m.ts)}`;
      if (out.at(-1)?.label === label) out.at(-1)!.items.push(m);
      else out.push({ label, items: [m] });
    });
    return out;
  }, [data]);

  return (
    <>
      <PageHeader
        title="Sent to Slack"
        sub="Everything the channel received, newest first. This is the whole feed: if a failure is not here, it was a repeat, and it was counted instead."
      />
      {error && <ErrorState message={error} onRetry={reload} />}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.62fr)] items-start gap-5">
        <ChannelFrame
          channel={data?.channel ?? "#alerts"}
          right={data && <span className="text-[12px] text-[#616061] tnum">Showing the latest {num(data.messages.length)} of {num(data.total)}</span>}
        >
          {!data && loading && <SkeletonRows rows={10} />}
          {data && data.messages.length === 0 && <EmptyState title="Nothing sent yet" body="The first event from any source will alert straight away and show up here." />}
          {groups.map((g) => (
            <section key={g.label}>
              <div className="relative my-2.5 flex justify-center before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-[#e8e6e3]">
                <span className="relative rounded-full border border-[#dddbd8] bg-white px-3 py-0.5 text-[12px] font-bold text-[#1d1c1d]">{g.label}</span>
              </div>
              {g.items.map((d) => (
                <SlackMessage
                  key={d.id}
                  delivery={d}
                  compact
                  footer={
                    <p className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-3">
                      <span className="rounded-full bg-accent-soft px-2 py-px font-medium text-accent-strong">{RULE_LABEL[d.rule]}</span>
                      {d.status === "failed" ? <span className="font-medium text-crit">Delivery failed: {d.error}</span> : <span>{d.status === "outbox" ? "Kept in demo outbox" : "Delivered to Slack"}</span>}
                      <Link to={`/incidents/${encodeURIComponent(d.fingerprint)}?alert=${d.event_id}`} className="ml-auto inline-flex items-center gap-1 font-medium text-accent hover:underline">
                        See the decision <ArrowRight size={11} aria-hidden />
                      </Link>
                    </p>
                  }
                />
              ))}
            </section>
          ))}
        </ChannelFrame>

        <div className="sticky top-5 space-y-5">
          <Panel className="overflow-hidden" title="What the channel was spared" hint="Last 7 days, per day. Bars share one scale.">
            {!stats ? (
              <SkeletonRows rows={7} />
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line">
                    <th className={th}>Day</th>
                    <th className={th}>Failures received vs messages sent</th>
                    <th className={thNum}>Received</th>
                    <th className={thNum}>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {perDay.map((d) => (
                    <tr key={d.t} className="border-b border-line last:border-0">
                      <td className={`${td} whitespace-nowrap`}>
                        <span className="font-medium">{weekday(d.t)}</span> <span className="text-ink-3">{day(d.t)}</span>
                      </td>
                      <td className={`${td} w-full`}>
                        <div className="space-y-[3px]" aria-hidden>
                          <div className="h-[5px] rounded-full bg-noise" style={{ width: `${Math.max(1, (100 * d.events) / maxEvents)}%` }} />
                          <div className="h-[5px] rounded-full bg-accent" style={{ width: `${Math.max(1, (100 * d.alerts) / maxEvents)}%` }} />
                        </div>
                      </td>
                      <td className={`${tdNum} text-ink-2`}>{num(d.events)}</td>
                      <td className={`${tdNum} font-medium`}>{num(d.alerts)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong bg-canvas">
                    <td className={`${td} font-medium`} colSpan={2}>Total</td>
                    <td className={`${tdNum} font-medium`}>{num(stats.totals.events)}</td>
                    <td className={`${tdNum} font-semibold text-accent`}>{num(stats.totals.alerts)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Panel>
          <Panel title="Delivery">
            <div className="space-y-2 px-4 py-3 text-[12.5px] leading-snug text-ink-2">
              {data?.delivery === "outbox" ? (
                <p>Demo mode: the Slack client is swapped for an in app outbox, so nothing leaves this machine. Payloads are identical to what Slack would get.</p>
              ) : (
                <p>Live: messages are posted to your Slack incoming webhook, with retries on network errors and 5xx answers.</p>
              )}
              <p>A failed delivery is recorded here with its error, never silently dropped.</p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
