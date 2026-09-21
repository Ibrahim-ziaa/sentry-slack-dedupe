import type { ReactNode } from "react";
import { AlertTriangle, BellOff, BellRing, Flame, RefreshCw } from "lucide-react";
import type { IncidentState, Kind, Severity } from "../lib/api";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-6 pb-5">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {sub && <p className="mt-1 max-w-[760px] text-[13px] text-ink-2">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, hint, right, children, className }: { title?: string; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {title && (
        <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
            {hint && <p className="mt-0.5 text-[12px] text-ink-3">{hint}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-canvas p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors",
            o.value === value ? "bg-raised text-ink shadow-[0_0_0_1px_var(--color-line-strong)]" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATE_STYLE: Record<IncidentState, { cls: string; label: string; Icon: typeof Flame }> = {
  escalated: { cls: "bg-crit-soft text-crit", label: "Escalated", Icon: Flame },
  active: { cls: "bg-warn-soft text-warn", label: "Active", Icon: BellRing },
  quiet: { cls: "bg-sunken text-ink-2", label: "Quiet", Icon: BellOff },
};

export function StatePill({ state }: { state: IncidentState }) {
  const s = STATE_STYLE[state];
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium", s.cls)}>
      <s.Icon size={11} strokeWidth={2.2} aria-hidden />
      {s.label}
    </span>
  );
}

const SEVERITY_DOT: Record<Severity, string> = { fatal: "bg-crit", error: "bg-crit", warning: "bg-warn", info: "bg-info" };

export function SeverityTag({ severity }: { severity: Severity }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] capitalize text-ink-2">
      <span className={cx("h-2 w-2 rounded-full", SEVERITY_DOT[severity], severity === "fatal" && "ring-2 ring-crit-soft")} aria-hidden />
      {severity}
    </span>
  );
}

export function SeverityDot({ severity }: { severity: Severity }) {
  return <span title={severity} className={cx("inline-block h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[severity])} aria-label={severity} />;
}

/** Text only source marks. No third party logos. */
export function KindBadge({ kind, label }: { kind: Kind; label: string }) {
  const mark = { sentry: "S", n8n: "n8", generic: "{}" }[kind];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
      <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-sunken px-1 font-mono text-[9.5px] font-semibold leading-none text-ink-2" aria-hidden>
        {mark}
      </span>
      {label}
    </span>
  );
}

export function Button({ children, variant = "secondary", className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const styles = {
    primary: "bg-accent text-on-accent font-semibold hover:bg-accent-strong border-transparent",
    secondary: "bg-sunken text-ink border-line-strong hover:bg-raised",
    ghost: "bg-transparent text-ink-2 border-transparent hover:bg-sunken hover:text-ink",
  }[variant];
  return (
    <button
      {...rest}
      className={cx("inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50", styles, className)}
    >
      {children}
    </button>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-crit-line bg-crit-soft px-4 py-3 text-[13px] text-crit">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex-1">
        <p className="font-medium">Could not load this view</p>
        <p className="text-[12.5px] opacity-90">{message}</p>
      </div>
      {onRetry && (
        <Button onClick={onRetry}>
          <RefreshCw size={13} aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <p className="text-[13.5px] font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-[420px] text-[12.5px] text-ink-2">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-5" style={{ width: `${92 - ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}

export const th = "px-4 py-2 text-left text-[11.5px] font-medium text-ink-3 whitespace-nowrap";
export const thNum = "px-3 py-2 text-right text-[11.5px] font-medium text-ink-3 whitespace-nowrap";
export const td = "px-4 py-2.5 align-middle";
export const tdNum = "px-3 py-2.5 text-right align-middle tnum";
