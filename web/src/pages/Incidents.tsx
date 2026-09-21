import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowDown, Search, X } from "lucide-react";
import { useApi, type Incident, type IncidentList, type IncidentState } from "../lib/api";
import { ago, dateTime, num } from "../lib/format";
import { useMeta } from "../lib/meta";
import { Sparkline } from "../components/TimelineChart";
import { Button, EmptyState, ErrorState, KindBadge, PageHeader, Panel, Segmented, SeverityDot, SkeletonRows, StatePill, cx, td, tdNum, th, thNum } from "../components/ui";

type SortKey = "last_seen" | "first_seen" | "events" | "alerts" | "suppressed";
const SORTS: Record<SortKey, string> = { last_seen: "Last seen", first_seen: "First seen", events: "Occurrences", alerts: "Alerts sent", suppressed: "Suppressed" };

export default function Incidents() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { version } = useMeta();

  const state = (params.get("state") ?? "") as IncidentState | "";
  const source = params.get("source") ?? "";
  const service = params.get("service") ?? "";
  const q = params.get("q") ?? "";
  const sort = (params.get("sort") && params.get("sort")! in SORTS ? params.get("sort") : "last_seen") as SortKey;

  const query = new URLSearchParams();
  if (source) query.set("source", source);
  if (service) query.set("service", service);
  if (q) query.set("q", q);
  // state is filtered client side so the counts on the state tabs stay visible for the other filters
  const { data, error, loading, reload } = useApi<IncidentList>(`/api/incidents?${query}&v=${version}`);

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const rows = useMemo(() => {
    const list = (data?.incidents ?? []).filter((r) => !state || r.state === state);
    return [...list].sort((a, b) => (b[sort] as number) - (a[sort] as number));
  }, [data, state, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { "": data?.incidents.length ?? 0, active: 0, escalated: 0, quiet: 0 };
    data?.incidents.forEach((r) => (c[r.state] += 1));
    return c;
  }, [data]);

  const filtered = Boolean(state || source || service || q);
  const totals = rows.reduce((acc, r) => ({ events: acc.events + r.events, alerts: acc.alerts + r.alerts }), { events: 0, alerts: 0 });

  const SortTh = ({ k, numeric }: { k: SortKey; numeric?: boolean }) => (
    <th className={numeric ? thNum : th} aria-sort={sort === k ? "descending" : undefined}>
      <button onClick={() => set("sort", k === "last_seen" ? "" : k)} className={cx("inline-flex items-center gap-1 hover:text-ink", sort === k && "text-ink")}>
        {SORTS[k]}
        <ArrowDown size={11} className={cx(sort === k ? "opacity-100" : "opacity-0")} aria-hidden />
      </button>
    </th>
  );

  return (
    <>
      <PageHeader
        title="Incidents"
        sub="One row per distinct problem. Repeats of the same failure are grouped by fingerprint, however many times it fires."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="State"
          value={state}
          onChange={(v) => set("state", v)}
          options={(["", "escalated", "active", "quiet"] as const).map((s) => ({
            value: s,
            label: (
              <span>
                {s === "" ? "All" : s[0].toUpperCase() + s.slice(1)} <span className="tnum text-ink-3">{counts[s]}</span>
              </span>
            ),
          }))}
        />
        <label className="relative">
          <span className="sr-only">Search incidents</span>
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="Search title, service or fingerprint"
            className="h-8 w-[280px] rounded-md border border-line-strong bg-sunken pl-8 pr-2 text-[12.5px] placeholder:text-ink-3"
          />
        </label>
        <select aria-label="Source" value={source} onChange={(e) => set("source", e.target.value)} className="h-8 rounded-md border border-line-strong bg-sunken px-2 text-[12.5px]">
          <option value="">All sources</option>
          {data?.facets.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Service" value={service} onChange={(e) => set("service", e.target.value)} className="h-8 max-w-[220px] rounded-md border border-line-strong bg-sunken px-2 text-[12.5px]">
          <option value="">All services</option>
          {service && !data?.facets.services.includes(service) && <option value={service}>{service}</option>}
          {data?.facets.services.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {filtered && (
          <Button variant="ghost" onClick={() => setParams(sort === "last_seen" ? {} : { sort }, { replace: true })}>
            <X size={13} aria-hidden /> Clear filters
          </Button>
        )}
        <p className="ml-auto text-[12px] text-ink-2 tnum">
          {num(rows.length)} {rows.length === 1 ? "incident" : "incidents"}, {num(totals.events)} events, {num(totals.alerts)} alerts sent
        </p>
      </div>

      {error && <ErrorState message={error} onRetry={reload} />}

      <Panel className={cx(loading && data && "opacity-70")}>
        {!data && loading ? (
          <SkeletonRows rows={12} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No incidents match these filters" : "No incidents yet"}
            body={filtered ? "Try a different state, source or search term." : "Point a source at its webhook URL, or send a test event from the Sources page."}
            action={filtered ? <Button onClick={() => setParams({}, { replace: true })}>Clear filters</Button> : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>Incident</th>
                  <th className={th}>Source</th>
                  <SortTh k="first_seen" />
                  <SortTh k="last_seen" />
                  <th className={th}>Last 7 days</th>
                  <SortTh k="events" numeric />
                  <SortTh k="alerts" numeric />
                  <SortTh k="suppressed" numeric />
                  <th className={th}>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: Incident) => (
                  <tr
                    key={r.fingerprint}
                    onClick={() => navigate(`/incidents/${encodeURIComponent(r.fingerprint)}`)}
                    onKeyDown={(e) => e.key === "Enter" && navigate(`/incidents/${encodeURIComponent(r.fingerprint)}`)}
                    tabIndex={0}
                    role="link"
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-sunken focus-visible:bg-sunken"
                  >
                    <td className={`${td} w-full max-w-0`}>
                      <div className="flex items-center gap-2">
                        <SeverityDot severity={r.severity} />
                        <span className="truncate font-medium">{r.title}</span>
                      </div>
                      <p className="truncate pl-4 text-[12px] text-ink-3">
                        {r.service}
                        {r.culprit && <span className="font-mono text-[11.5px]"> · {r.culprit}</span>}
                      </p>
                    </td>
                    <td className={`${td} whitespace-nowrap`}><KindBadge kind={r.kind} label={r.kind_label} /></td>
                    <td className={`${td} whitespace-nowrap text-ink-2 tnum`}>{dateTime(r.first_seen)}</td>
                    <td className={`${td} whitespace-nowrap tnum`} title={dateTime(r.last_seen)}>{ago(r.last_seen, data!.now)}</td>
                    <td className={td}><Sparkline values={r.activity} width={84} /></td>
                    <td className={tdNum}>{num(r.events)}</td>
                    <td className={`${tdNum} font-medium`}>{num(r.alerts)}</td>
                    <td className={`${tdNum} text-ink-2`}>{num(r.suppressed)}</td>
                    <td className={`${td} whitespace-nowrap`}><StatePill state={r.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="mt-3 text-[12px] text-ink-3">
        Active: fired again inside its quiet window. Escalated: active, and it has crossed an escalation threshold. Quiet: nothing since the window ran out.
      </p>
    </>
  );
}
