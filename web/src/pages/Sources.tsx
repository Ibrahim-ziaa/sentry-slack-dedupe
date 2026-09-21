import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, BellOff, BellRing, Check, Copy, Send, ShieldAlert, ShieldCheck } from "lucide-react";
import { request, useApi, type IntakeResult, type SampleRequest, type Source } from "../lib/api";
import { ago, duration, num, RULE_LABEL } from "../lib/format";
import { useMeta } from "../lib/meta";
import { Button, ErrorState, KindBadge, PageHeader, Panel, SkeletonRows, cx, td, tdNum, th, thNum } from "../components/ui";

const SETUP: Record<Source["kind"], string[]> = {
  sentry: [
    "In Sentry, open Settings, Integrations, Webhooks and paste the URL above.",
    "Add an alert rule with the action: send a notification via webhooks.",
    "Set SENTRY_CLIENT_SECRET to the integration's client secret to turn on the signature check.",
  ],
  n8n: [
    "Create one workflow that starts with an Error Trigger node.",
    "Add an HTTP Request node: POST, this URL, body set to the incoming item as JSON.",
    "In each production workflow, open Settings and choose it as the Error Workflow. One error workflow covers them all.",
  ],
  generic: [
    "POST JSON from anything: a cron wrapper, a queue worker, a Zapier or Make scenario.",
    "Only 'title' is required. 'service', 'severity', 'details' and 'url' make the alert more useful.",
    "Send your own 'fingerprint' when you want to control what counts as the same problem.",
  ],
};

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      aria-label="Copy webhook URL"
      className="rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink"
    >
      {done ? <Check size={13} className="text-ok" aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

function Signature({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11.5px] font-medium text-ok"><ShieldCheck size={11} aria-hidden /> Verified</span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-medium text-warn"><ShieldAlert size={11} aria-hidden /> Not checked</span>
  );
}

export default function Sources() {
  const [params, setParams] = useSearchParams();
  const { version, bump } = useMeta();
  const { data, error, loading, reload } = useApi<{ sources: Source[] }>(`/api/sources?v=${version}`);
  const { meta } = useMeta();
  const selectedId = params.get("source") ?? data?.sources[0]?.id ?? null;
  const selected = data?.sources.find((s) => s.id === selectedId) ?? null;

  const [fresh, setFresh] = useState(params.get("fresh") === "1");
  const { data: sample } = useApi<SampleRequest>(selected ? `/api/sources/${selected.id}/sample?fresh=${fresh ? 1 : 0}&v=${version}` : null);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<(IntakeResult & { at: number })[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const autoSent = useRef(false);

  useEffect(() => {
    setResults([]);
    setSendError(null);
  }, [selectedId]);

  async function send() {
    if (!sample) return;
    setSending(true);
    setSendError(null);
    try {
      // A real HTTP POST to the public intake, exactly what Sentry, n8n or a cron job would do.
      const res = await request<IntakeResult>(sample.path, { method: sample.method, headers: sample.headers, body: sample.body });
      setResults((r) => [{ ...res, at: Date.now() }, ...r].slice(0, 5));
      bump();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ?send=N posts N test events on load, so the result state can be linked to (and captured) directly.
  useEffect(() => {
    const n = Number(params.get("send") ?? 0);
    if (!n || !sample || autoSent.current) return;
    autoSent.current = true;
    (async () => {
      for (let i = 0; i < Math.min(n, 5); i++) await send();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample]);

  const origin = window.location.origin;

  return (
    <>
      <PageHeader
        title="Sources"
        sub="Each source gets its own webhook URL. Whatever the payload looks like, it is turned into the same kind of event and judged by the same rules."
      />
      {error && <ErrorState message={error} onRetry={reload} />}

      <Panel>
        {!data && loading ? (
          <SkeletonRows rows={4} />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>Source</th>
                <th className={th}>Webhook URL</th>
                <th className={th}>Signature check</th>
                <th className={th}>Rules in force</th>
                <th className={thNum}>Events</th>
                <th className={thNum}>Alerts</th>
                <th className={thNum}>Last event</th>
              </tr>
            </thead>
            <tbody>
              {data?.sources.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setParams({ source: s.id }, { replace: true })}
                  onKeyDown={(e) => e.key === "Enter" && setParams({ source: s.id }, { replace: true })}
                  tabIndex={0}
                  aria-selected={s.id === selectedId}
                  className={cx("cursor-pointer border-b border-line last:border-0", s.id === selectedId ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]" : "hover:bg-sunken")}
                >
                  <td className={td}>
                    <p className="font-medium">{s.name}</p>
                    <KindBadge kind={s.kind} label={s.kind === "generic" ? "Custom JSON" : s.kind_label} />
                  </td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-1 rounded border border-line bg-canvas py-0.5 pl-2 pr-1 font-mono text-[12px]">
                      {origin}{s.path}
                      <CopyButton text={`${origin}${s.path}`} />
                    </span>
                  </td>
                  <td className={td}><Signature on={s.signature_required} /></td>
                  <td className={`${td} text-ink-2`}>
                    {duration(s.window_seconds)} quiet, escalate at {s.escalate_at.join(", ") || "never"}
                    {s.has_override && <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-ink-2">override</span>}
                  </td>
                  <td className={tdNum}>{num(s.events)}</td>
                  <td className={`${tdNum} font-medium`}>{num(s.alerts)}</td>
                  <td className={`${tdNum} text-ink-2`}>{s.last_seen && meta ? ago(s.last_seen, Math.max(meta.now, s.last_seen)) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {selected && (
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-5">
          <Panel title={`Connect ${selected.name}`} hint={selected.description}>
            <ol className="space-y-2.5 px-4 py-3.5">
              {SETUP[selected.kind].map((step, i) => (
                <li key={i} className="grid grid-cols-[24px_1fr] text-[12.5px] leading-snug text-ink-2">
                  <span className="font-semibold text-ink tnum">{i + 1}.</span>
                  {step}
                </li>
              ))}
            </ol>
            <div className="border-t border-line px-4 py-3 text-[12.5px] leading-snug text-ink-2">
              <p className="font-medium text-ink">Signature check: {selected.signature_required ? "on" : "off"}</p>
              {selected.signature_required ? (
                <p className="mt-0.5">
                  Requests must carry <span className="font-mono text-[12px]">{selected.signature_header}</span> (HMAC SHA256 of the body)
                  {selected.kind !== "sentry" && " or the shared secret as a bearer token"}. Anything else gets a 401 and is not counted.
                </p>
              ) : (
                <p className="mt-0.5">No secret is set for this source, so any caller that knows the URL can post. Set <span className="font-mono text-[12px]">HOOK_SECRET_{selected.id.toUpperCase()}</span> to require one.</p>
              )}
            </div>
          </Panel>

          <Panel
            title="Send a test event"
            hint="A real POST from your browser to the webhook above. It goes through the same parser, rules and Slack delivery as production traffic."
          >
            <div className="px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant="primary" onClick={send} disabled={!sample || sending} className="shrink-0 whitespace-nowrap">
                  <Send size={13} aria-hidden /> {sending ? "Sending" : "Send test event"}
                </Button>
                <label className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-ink-2">
                  <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} className="accent-[var(--color-accent)]" />
                  New fingerprint each time
                </label>
                <span className="text-[12px] text-ink-3">{fresh ? "Every send is a new incident" : "Send it twice to watch the second one get suppressed"}</span>
              </div>

              {sendError && <p role="alert" className="mt-3 rounded-md bg-crit-soft px-3 py-2 text-[12.5px] text-crit">The intake rejected it: {sendError}</p>}

              {results.length > 0 && (
                <ul className="mt-3 divide-y divide-line rounded-md border border-line">
                  {results.map((r) => (
                    <li key={r.event_id} className="flex items-center gap-2.5 px-3 py-2 text-[12.5px]">
                      {r.notified ? (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent"><BellRing size={11} aria-hidden /></span>
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-canvas text-ink-3"><BellOff size={10} aria-hidden /></span>
                      )}
                      <span className="font-medium">{r.notified ? "Alert sent" : "Suppressed"}</span>
                      <span className="text-ink-2">{RULE_LABEL[r.rule]}, occurrence #{num(r.count)}</span>
                      <Link to={`/incidents/${encodeURIComponent(r.fingerprint)}`} className="ml-auto inline-flex items-center gap-1 font-medium text-accent hover:underline">
                        View incident <ArrowRight size={11} aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {sample && (
                <div className="mt-3 overflow-hidden rounded-md border border-line bg-canvas">
                  <p className="border-b border-line px-3 py-1.5 font-mono text-[11.5px] text-ink-2">
                    <span className="font-semibold text-ink">POST</span> {sample.path}
                    {Object.keys(sample.headers).filter((h) => h !== "Content-Type").map((h) => <span key={h} className="ml-3 text-ink-3">{h}: {sample.headers[h].slice(0, 12)}…</span>)}
                  </p>
                  <pre className="max-h-[260px] overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{sample.body}</pre>
                  <p className="border-t border-line px-3 py-1.5 text-[12px] text-ink-3">{sample.note}</p>
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
