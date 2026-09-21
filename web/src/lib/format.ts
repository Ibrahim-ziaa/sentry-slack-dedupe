import type { Rule } from "./api";

export const num = (n: number) => n.toLocaleString("en-US");

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 10 && tens <= 20 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${num(n)}${suffix}`;
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const secFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });

export const day = (ts: number) => dayFmt.format(ts * 1000);
export const time = (ts: number) => timeFmt.format(ts * 1000);
export const timeSec = (ts: number) => secFmt.format(ts * 1000);
export const weekday = (ts: number) => weekdayFmt.format(ts * 1000);
export const dateTime = (ts: number) => `${day(ts)}, ${time(ts)}`;

export function ago(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = seconds / 3600;
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)} ${h === 1 ? "hour" : "hours"}`;
  const d = seconds / 86400;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} days`;
}

export const RULE_LABEL: Record<Rule, string> = {
  first_occurrence: "First occurrence",
  quiet_window: "Inside quiet window",
  escalation: "Escalation",
  window_expired: "Quiet window expired",
};
