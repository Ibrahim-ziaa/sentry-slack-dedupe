import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bucket } from "../lib/api";
import { day, num, time, weekday } from "../lib/format";

/**
 * Events received versus alerts sent, on ONE shared axis: the gap between the two lines is the point.
 * Because alerts are tiny next to events, a second small chart below shows alerts alone on their own scale.
 */

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setWidth(Math.floor(ref.current.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function TimelineChart({ buckets, step }: { buckets: Bucket[]; step: number }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const H = 250;
  const STRIP = 54;
  const pad = { l: 44, r: 118, t: 12, b: 8 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;
  const n = buckets.length;

  const geo = useMemo(() => {
    const yMax = niceMax(Math.max(1, ...buckets.map((b) => b.events)));
    const aMax = Math.max(1, ...buckets.map((b) => b.alerts));
    const x = (i: number) => pad.l + ((i + 0.5) / n) * innerW;
    const y = (v: number) => pad.t + innerH - (v / yMax) * innerH;
    const line = (key: "events" | "alerts") => buckets.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b[key]).toFixed(1)}`).join("");
    const area = `${line("events")}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    return { yMax, aMax, x, y, line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, innerW]);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * geo.yMax);
  const xLabels = useMemo(() => {
    const out: { i: number; top: string; bottom?: string }[] = [];
    buckets.forEach((b, i) => {
      const d = new Date(b.t * 1000);
      if (step >= 2 * 3600) {
        if (d.getHours() < step / 3600) out.push({ i, top: weekday(b.t), bottom: day(b.t) });
      } else if (d.getHours() % 4 === 0) out.push({ i, top: time(b.t), bottom: d.getHours() === 0 ? day(b.t) : undefined });
    });
    return out;
  }, [buckets, step]);

  const last = buckets[n - 1];
  let yEventsLabel = last ? geo.y(last.events) : 0;
  const yAlertsLabel = last ? geo.y(last.alerts) : 0;
  if (yAlertsLabel - yEventsLabel < 15) yEventsLabel = yAlertsLabel - 15;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - pad.l;
    const i = Math.floor((px / innerW) * n);
    setHover(i >= 0 && i < n ? i : null);
  }

  const hb = hover !== null ? buckets[hover] : null;
  const tipLeft = hover !== null ? geo.x(hover) : 0;
  const flip = tipLeft > width - 260;

  return (
    <div ref={ref} className="relative select-none">
      {width > 0 && (
        <>
          <svg width={width} height={H + STRIP + 40} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
            aria-label="Events received versus alerts sent over time">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={pad.l + innerW} y1={geo.y(t)} y2={geo.y(t)} stroke={t === 0 ? "var(--color-line-strong)" : "var(--color-line)"} strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 3"} />
                <text x={pad.l - 8} y={geo.y(t) + 4} textAnchor="end" className="fill-ink-3 text-[11px] tnum">{num(t)}</text>
              </g>
            ))}
            <path d={geo.area} fill="var(--color-noise-soft)" />
            <path d={geo.line("events")} fill="none" stroke="var(--color-noise)" strokeWidth={2} strokeLinejoin="round" />
            <path d={geo.line("alerts")} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />

            {last && (
              <g className="text-[11.5px] font-medium">
                <circle cx={geo.x(n - 1)} cy={geo.y(last.events)} r={3.5} fill="var(--color-noise)" stroke="var(--color-surface)" strokeWidth={2} />
                <circle cx={geo.x(n - 1)} cy={geo.y(last.alerts)} r={3.5} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
                <text x={geo.x(n - 1) + 10} y={yEventsLabel + 4} className="fill-ink-2">Events received</text>
                <text x={geo.x(n - 1) + 10} y={yAlertsLabel + 4} className="fill-ink">Alerts sent</text>
              </g>
            )}

            {/* alerts alone, own scale */}
            <g transform={`translate(0, ${H + 6})`}>
              <text x={pad.l + innerW + 10} y={STRIP - 6} className="fill-ink-3 text-[11px]">Alerts only,</text>
              <text x={pad.l + innerW + 10} y={STRIP + 8} className="fill-ink-3 text-[11px]">own scale (max {geo.aMax})</text>
              <line x1={pad.l} x2={pad.l + innerW} y1={STRIP} y2={STRIP} stroke="var(--color-line-strong)" />
              {buckets.map((b, i) => {
                const bw = Math.max(2, Math.min(14, innerW / n - 3));
                const h = (b.alerts / geo.aMax) * (STRIP - 6);
                return b.alerts ? (
                  <rect key={i} x={geo.x(i) - bw / 2} y={STRIP - h} width={bw} height={h} rx={Math.min(2, bw / 2)} fill="var(--color-accent)" opacity={hover === null || hover === i ? 1 : 0.45} />
                ) : null;
              })}
              <text x={pad.l - 8} y={12} textAnchor="end" className="fill-ink-3 text-[11px] tnum">{geo.aMax}</text>
              <text x={pad.l - 8} y={STRIP + 4} textAnchor="end" className="fill-ink-3 text-[11px] tnum">0</text>
            </g>

            {xLabels.map((l) => (
              <g key={l.i} className="text-[11px]">
                <text x={geo.x(l.i) - innerW / n / 2} y={H + STRIP + 22} className="fill-ink-2">{l.top}</text>
                {l.bottom && <text x={geo.x(l.i) - innerW / n / 2} y={H + STRIP + 36} className="fill-ink-3">{l.bottom}</text>}
              </g>
            ))}

            {hb && hover !== null && (
              <g pointerEvents="none">
                <line x1={geo.x(hover)} x2={geo.x(hover)} y1={pad.t} y2={H + STRIP + 6} stroke="var(--color-ink-3)" strokeWidth={1} />
                <circle cx={geo.x(hover)} cy={geo.y(hb.events)} r={4} fill="var(--color-noise)" stroke="var(--color-surface)" strokeWidth={2} />
                <circle cx={geo.x(hover)} cy={geo.y(hb.alerts)} r={4} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
              </g>
            )}
          </svg>
          {hb && (
            <div
              className="pointer-events-none absolute top-2 z-10 w-[220px] rounded-md border border-line-strong bg-raised px-3 py-2 text-[12px]"
              style={flip ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }}
            >
              <p className="font-medium text-ink">
                {day(hb.t)}, {time(hb.t)} to {time(hb.t + step)}
              </p>
              <dl className="mt-1.5 space-y-1 tnum">
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-2"><span className="h-0.5 w-3 rounded bg-noise" />Events received</dt>
                  <dd className="font-medium">{num(hb.events)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-ink-2"><span className="h-0.5 w-3 rounded bg-accent" />Alerts sent</dt>
                  <dd className="font-medium">{num(hb.alerts)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-line-strong pt-1">
                  <dt className="text-ink-2">Held back</dt>
                  <dd className="font-medium">{num(hb.events - hb.alerts)}</dd>
                </div>
              </dl>
            </div>
          )}
        </>
      )}
      {width === 0 && <div className="skeleton" style={{ height: H + STRIP + 40 }} />}
    </div>
  );
}

export function Sparkline({ values, width = 96, height = 22 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const bw = width / values.length;
  return (
    <svg width={width} height={height} aria-hidden className="block">
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--color-line-strong)" />
      {values.map((v, i) =>
        v ? <rect key={i} x={i * bw + 0.5} y={height - Math.max(2, (v / max) * (height - 2))} width={Math.max(1, bw - 1)} height={Math.max(2, (v / max) * (height - 2))} rx={0.75} fill="var(--color-noise)" /> : null,
      )}
    </svg>
  );
}
