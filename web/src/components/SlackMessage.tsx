import type { ReactNode } from "react";
import type { Delivery, SlackBlock } from "../lib/api";
import { day, time } from "../lib/format";
import { cx } from "./ui";

/**
 * Renders the exact Block Kit payload that was handed to the Slack client, in the visual language of a
 * chat message (our own HTML and CSS, no third party brand assets). Supports the block types the hub emits.
 */

function mrkdwn(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*([^*\n]+)\*|`([^`\n]+)`|<([^|>]+)\|([^>]+)>|\n/g;
  let last = 0;
  let key = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={key++} className="font-bold">{m[1]}</strong>);
    else if (m[2] !== undefined)
      out.push(
        <code key={key++} className="rounded-[3px] border border-[#e1dfdc] bg-[#f6f5f3] px-[3px] py-px font-mono text-[12px] text-[#c0335a]">
          {m[2]}
        </code>,
      );
    else if (m[3] !== undefined) out.push(<a key={key++} href={m[3]} className="text-[#1264a3] hover:underline">{m[4]}</a>);
    else out.push(<br key={key++} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Block({ block }: { block: SlackBlock }) {
  if (block.type === "section") {
    return (
      <div className="text-[14px] leading-[1.46] text-[#1d1c1d]">
        {block.text && <div>{mrkdwn(block.text.text)}</div>}
        {block.fields && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-0.5">
            {block.fields.map((f, i) => (
              <div key={i}>{mrkdwn(f.text)}</div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (block.type === "context") {
    return (
      <div className="flex flex-wrap gap-x-2.5 text-[12.5px] leading-[1.4] text-[#616061]">
        {block.elements?.map((e, i) => <span key={i}>{mrkdwn(typeof e.text === "string" ? e.text : (e.text?.text ?? ""))}</span>)}
      </div>
    );
  }
  if (block.type === "actions") {
    return (
      <div className="flex gap-2 pt-0.5">
        {block.elements?.map((e, i) => (
          <a
            key={i}
            href={e.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center rounded border border-[#c9c8c7] bg-white px-3 text-[13px] font-bold text-[#1d1c1d] hover:bg-[#f8f8f8]"
          >
            {typeof e.text === "string" ? e.text : e.text?.text}
          </a>
        ))}
      </div>
    );
  }
  return <hr className="border-[#e1dfdc]" />;
}

export function SlackMessage({ delivery, selected, footer, compact }: { delivery: Delivery; selected?: boolean; footer?: ReactNode; compact?: boolean }) {
  return (
    <article
      className={cx(
        "flex gap-2.5 px-4 py-2.5 transition-colors",
        selected ? "bg-[#fdf6e3] shadow-[inset_3px_0_0_#e0a422]" : "hover:bg-[#f8f8f8]",
      )}
    >
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand text-on-accent" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
          <path d="M4 11V8.5M8 11V5M12 11V9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[14.5px] font-black leading-tight text-[#1d1c1d]">Alert Console</span>
          <span className="rounded-[3px] bg-[#e8e8e8] px-1 text-[10px] font-semibold uppercase leading-[15px] tracking-wide text-[#555]">App</span>
          <span className="text-[12px] text-[#616061] tnum">
            {day(delivery.ts)} at {time(delivery.ts)}
          </span>
        </div>
        <div className={cx("mt-1", compact ? "max-w-[660px] space-y-1.5" : "space-y-2")}>
          {delivery.payload.blocks.map((b, i) => (compact && b.type === "actions" ? null : <Block key={i} block={b} />))}
        </div>
        {footer}
      </div>
    </article>
  );
}

export function ChannelFrame({ channel, right, children, className }: { channel: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-[10px] border border-line-strong bg-sunken p-1.5", className)}>
      <div className="paper overflow-hidden rounded-md bg-white">
      <div className="flex items-center justify-between border-b border-[#e1dfdc] px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-black text-[#1d1c1d]">{channel}</span>
          <span className="text-[12px] text-[#616061]">message preview</span>
        </div>
        {right}
      </div>
      {children}
      </div>
    </div>
  );
}
