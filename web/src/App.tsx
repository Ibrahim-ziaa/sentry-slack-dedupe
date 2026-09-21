import { useCallback, useMemo, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Activity, Inbox, ListFilter, RotateCcw, SlidersHorizontal, Webhook } from "lucide-react";
import { request, useApi, type Meta } from "./lib/api";
import { MetaCtx } from "./lib/meta";
import { cx } from "./components/ui";
import Overview from "./pages/Overview";
import Incidents from "./pages/Incidents";
import IncidentDetail from "./pages/IncidentDetail";
import Outbox from "./pages/Outbox";
import Rules from "./pages/Rules";
import Sources from "./pages/Sources";

const NAV = [
  { to: "/", label: "Overview", Icon: Activity, end: true },
  { to: "/incidents", label: "Incidents", Icon: ListFilter },
  { to: "/outbox", label: "Sent to Slack", Icon: Inbox },
  { to: "/rules", label: "Rules", Icon: SlidersHorizontal },
  { to: "/sources", label: "Sources", Icon: Webhook },
];

function Wordmark() {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-on-accent" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 11V8.5M8 11V5M12 11V9.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">Alert Console</span>
    </div>
  );
}

export default function App() {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const { data: meta } = useApi<Meta>(`/api/meta?v=${version}`);
  const [resetting, setResetting] = useState(false);
  const ctx = useMemo(() => ({ meta, version, bump }), [meta, version, bump]);

  async function reset() {
    setResetting(true);
    try {
      await request("/api/demo/reset", { method: "POST" });
      bump();
    } finally {
      setResetting(false);
    }
  }

  return (
    <MetaCtx.Provider value={ctx}>
      <div className="flex min-h-full">
        <aside className="sticky top-0 flex h-screen w-[216px] shrink-0 flex-col border-r border-line bg-rail px-3 py-4">
          <Wordmark />
          <nav className="mt-6 space-y-0.5" aria-label="Main">
            {NAV.map(({ to, label, Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors",
                    isActive ? "bg-accent-soft text-accent-strong shadow-[inset_0_0_0_1px_var(--color-accent-line)]" : "text-ink-2 hover:bg-sunken hover:text-ink",
                  )
                }
              >
                <Icon size={15} strokeWidth={1.9} aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto space-y-3">
            {meta && (
              <div className="rounded-md border border-line bg-surface px-2.5 py-2 text-[11.5px] leading-snug text-ink-2">
                <p className="flex items-center gap-1.5 font-medium text-ink">
                  <span className={cx("h-1.5 w-1.5 rounded-full", meta.delivery === "outbox" ? "bg-warn" : "bg-ok")} aria-hidden />
                  {meta.delivery === "outbox" ? "Slack delivery: outbox" : "Slack delivery: live"}
                </p>
                <p className="mt-0.5">
                  {meta.delivery === "outbox" ? "Messages are kept in the app. Nothing leaves this machine." : `Posting to ${meta.channel}.`}
                </p>
              </div>
            )}
            {meta?.demo && (
              <div className="rounded-md border border-dashed border-line-strong px-2.5 py-2 text-[11.5px] leading-snug text-ink-2">
                <p className="font-medium text-ink">Demo data</p>
                <p className="mt-0.5">{meta.company} is a fictional company. A scripted week of traffic was replayed through the real intake at startup.</p>
                <button
                  onClick={reset}
                  disabled={resetting}
                  className="mt-2 inline-flex items-center gap-1.5 font-medium text-accent hover:text-accent-strong disabled:opacity-50"
                >
                  <RotateCcw size={12} className={cx(resetting && "animate-spin")} aria-hidden />
                  {resetting ? "Replaying the week" : "Reset demo"}
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1360px] px-8 py-7">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/incidents" element={<Incidents />} />
              <Route path="/incidents/*" element={<IncidentDetail />} />
              <Route path="/outbox" element={<Outbox />} />
              <Route path="/rules" element={<Rules />} />
              <Route path="/sources" element={<Sources />} />
              <Route
                path="*"
                element={
                  <div className="py-20 text-center">
                    <p className="text-[15px] font-semibold">Page not found</p>
                    <NavLink to="/" className="mt-2 inline-block text-accent hover:underline">Back to the overview</NavLink>
                  </div>
                }
              />
            </Routes>
          </div>
        </main>
      </div>
    </MetaCtx.Provider>
  );
}
