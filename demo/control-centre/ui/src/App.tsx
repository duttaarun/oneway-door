import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './store';
import SystemMap from './components/SystemMap';
import { LogConsole, Metrics } from './components/Rail';
import { ControlRoom, SystemCheck } from './components/Drawers';
import Act1 from './acts/Act1';
import Act2 from './acts/Act2';
import Act3 from './acts/Act3';
import Act4 from './acts/Act4';
import Act5 from './acts/Act5';

const ACTS = [
  { n: 1, name: 'The PR', el: <Act1 /> },
  { n: 2, name: 'The incident', el: <Act2 /> },
  { n: 3, name: 'The review', el: <Act3 /> },
  { n: 4, name: 'The split', el: <Act4 /> },
  { n: 5, name: 'The proof', el: <Act5 /> },
];

function readAct(): number {
  const m = /act=(\d)/.exec(window.location.hash);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 5 ? n : 1;
}

function Shell() {
  const { store, mode, setMode, connected, post, recording } = useStore();
  const [act, setAct] = useState(readAct);
  const [drawer, setDrawer] = useState<'control' | 'check' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const infra = store.state?.infra.status;

  useEffect(() => {
    window.location.hash = `act=${act}`;
  }, [act]);

  useEffect(() => {
    const onHash = () => setAct(readAct());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      if (/^[1-5]$/.test(e.key)) setAct(Number(e.key));
      if (e.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const say = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 3200);
  };

  const prepare = async () => {
    const r = await post('/prepare');
    if (!r.ok) say(r.message ?? 'Failed');
  };

  const infraPill = mode === 'replay'
    ? <span className="pill-status"><span className="dot dot-starting" /> Replay</span>
    : !connected
      ? <span className="pill-status"><span className="dot dot-failed" /> Control Centre offline</span>
      : infra === 'UP'
        ? <span className="pill-status"><span className="dot dot-up" /> Postgres + Kafka up</span>
        : infra === 'FAILED'
          ? <span className="pill-status"><span className="dot dot-failed" /> Infra failed</span>
          : <span className="pill-status"><span className="dot dot-starting" /> Starting infra</span>;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 32 32"><path d="M10 6h13v20H10z" fill="none" stroke="#11B67A" strokeWidth="3" /><path d="M18 16H6m4-4-4 4 4 4" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="brand-name">One-Way Door</span>
          <span className="brand-sub">Demo Control Centre · Northwind Payments</span>
        </div>
        <div className="top-actions">
          {infraPill}
          <div className="segmented" role="group" aria-label="Mode">
            <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live</button>
            <button className={mode === 'replay' ? 'on' : ''} onClick={() => setMode('replay')}>Replay</button>
          </div>
          <button className="btn btn-white hide-sm" onClick={() => setDrawer('check')}>System check</button>
          <button className="btn btn-white hide-sm" onClick={() => setDrawer('control')}>Control room</button>
          <button className="btn btn-black" disabled={!!store.busy || mode === 'replay'} onClick={prepare}>Prepare</button>
        </div>
      </header>
      <nav className="navbar" aria-label="Acts">
        {ACTS.map((a) => (
          <button key={a.n} className={`tab ${act === a.n ? 'on' : ''}`} onClick={() => setAct(a.n)}>
            <small>{a.n}</small>{a.name}
          </button>
        ))}
        <span className="spacer" />
        {store.busy && <span className="busy"><span className="spinner" /><span>{store.busy}</span></span>}
      </nav>
      {mode === 'replay' && (
        <div className="replay-banner">
          <span>Replay: a real run recorded {recording ? new Date(recording.recordedAt).toLocaleString('en-GB') : ''}{recording?.reproduced ? ', which reproduced the incident' : ''}. Nothing is running now.</span>
          <button className="btn btn-black" onClick={() => setMode('live')}>Back to live</button>
        </div>
      )}

      <SystemMap />

      <main className="workspace">
        <div>{ACTS[act - 1].el}</div>
        <aside className="rail">
          <Metrics />
          <LogConsole />
        </aside>
      </main>

      {drawer === 'control' && <ControlRoom onClose={() => setDrawer(null)} toast={say} />}
      {drawer === 'check' && <SystemCheck onClose={() => setDrawer(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
