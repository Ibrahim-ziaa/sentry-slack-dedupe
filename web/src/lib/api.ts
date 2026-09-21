import { useCallback, useEffect, useRef, useState } from "react";

export type Kind = "sentry" | "n8n" | "generic";
export type Rule = "first_occurrence" | "quiet_window" | "escalation" | "window_expired";
export type IncidentState = "active" | "escalated" | "quiet";
export type Severity = "fatal" | "error" | "warning" | "info";

export interface Meta {
  product: string;
  demo: boolean;
  company: string;
  channel: string;
  delivery: "outbox" | "slack";
  now: number;
  seeded_events: number;
}

export interface Totals {
  events: number;
  alerts: number;
  suppressed: number;
  incidents: number;
  reduction_pct: number | null;
}

export interface Bucket {
  t: number;
  events: number;
  alerts: number;
}

export interface NoisyIncident {
  fingerprint: string;
  title: string;
  service: string;
  source: string;
  kind: Kind;
  kind_label: string;
  severity: Severity;
  events: number;
  alerts: number;
  suppressed: number;
}

export interface SourceSummary {
  id: string;
  name: string;
  kind: Kind;
  kind_label: string;
  events: number;
  alerts: number;
  incidents: number;
  last_seen: number | null;
}

export interface Stats {
  range: string;
  since: number;
  until: number;
  step: number;
  now: number;
  totals: Totals;
  buckets: Bucket[];
  rules_fired: Partial<Record<Rule, number>>;
  top_noisy: NoisyIncident[];
  sources: SourceSummary[];
}

export interface Incident {
  fingerprint: string;
  source: string;
  source_name: string;
  kind: Kind;
  kind_label: string;
  title: string;
  service: string;
  severity: Severity;
  environment: string;
  culprit: string;
  url: string;
  details?: string;
  window_seconds: number;
  first_seen: number;
  last_seen: number;
  last_alert: number | null;
  events: number;
  alerts: number;
  suppressed: number;
  escalations: number;
  state: IncidentState;
  activity: number[];
}

export interface IncidentList {
  incidents: Incident[];
  total: number;
  now: number;
  facets: {
    sources: { id: string; name: string }[];
    services: string[];
    states: Record<IncidentState, number>;
  };
}

export interface AlertItem {
  type: "alert";
  event_id: number;
  ts: number;
  count: number;
  rule: Rule;
  reason: string;
  suppressed: number;
  window_seconds: number;
  delivery_id: number | null;
}

export interface SuppressedRun {
  type: "suppressed";
  n: number;
  rule: Rule;
  from_ts: number;
  to_ts: number;
  from_id: number;
  to_id: number;
  from_count: number;
  to_count: number;
  window_seconds: number;
}

export type TimelineItem = AlertItem | SuppressedRun;

export interface SlackBlock {
  type: "section" | "context" | "actions" | "divider";
  text?: { type: string; text: string };
  fields?: { type: string; text: string }[];
  elements?: { type: string; text?: string | { type: string; text: string }; url?: string }[];
}

export interface Delivery {
  id: number;
  ts: number;
  event_id: number;
  fingerprint: string;
  mode: "outbox" | "slack";
  status: "outbox" | "sent" | "failed";
  error: string | null;
  payload: { text: string; blocks: SlackBlock[] };
  rule: Rule;
  reason: string;
  count: number;
  suppressed: number;
  source: string;
  kind: Kind;
  service: string;
  title: string;
  severity: Severity;
}

export interface IncidentDetail {
  incident: Incident;
  timeline: TimelineItem[];
  deliveries: Delivery[];
  channel: string;
  now: number;
}

export interface EventRow {
  id: number;
  ts: number;
  count: number;
  rule: Rule;
  reason: string;
  notified: number;
  title: string;
}

export interface RuleSet {
  window_seconds: number;
  escalate_at: number[];
  overrides: Record<string, { window_seconds?: number; escalate_at?: number[] }>;
}

export interface RulesPreview {
  events: number;
  current_alerts: number;
  proposed_alerts: number;
  by_source: { id: string; events: number; current_alerts: number; proposed_alerts: number }[];
}

export interface Source {
  id: string;
  name: string;
  kind: Kind;
  kind_label: string;
  description: string;
  path: string;
  signature_required: boolean;
  signature_header: string;
  events: number;
  alerts: number;
  incidents: number;
  events_24h: number;
  last_seen: number | null;
  window_seconds: number;
  escalate_at: number[];
  has_override: boolean;
}

export interface SampleRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  note: string;
}

export interface IntakeResult {
  event_id: number;
  source: string;
  fingerprint: string;
  notified: boolean;
  delivered: boolean | null;
  count: number;
  suppressed_since_last: number;
  rule: Rule;
  reason: string;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* keep the status text */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const sendJson = <T,>(path: string, method: string, body: unknown) =>
  request<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch JSON, refetch when the path changes, keep the previous data on screen while the next loads. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!path) return;
    const id = ++latest.current;
    setLoading(true);
    request<T>(path)
      .then((d) => {
        if (id !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => id === latest.current && setError(e.message))
      .finally(() => id === latest.current && setLoading(false));
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
