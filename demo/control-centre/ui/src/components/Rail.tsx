import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { count, money } from '../format';

export function Metrics() {
  const { store } = useStore();
  const s = store.state;
  const sent = s?.traffic.total ?? 0;
  const booked = s?.ledger?.booked ?? 0;
  const rows = s?.ledger?.rows ?? 0;
  const lag = s?.kafka?.lag ?? 0;
  const dlt = s?.kafka?.dlt ?? 0;
  const zero = s?.ledger?.zero ?? 0;
  // Money still on the topic isn't missing yet; it's missing once it's booked wrong.
  const missing = Math.max(0, Math.round((sent - booked) * 100) / 100);
  const inFlight = lag > 0;
  return (
    <div className="metrics" aria-label="Ledger metrics">
      <div className="metric"><div className="k">Settlements sent</div><div className="v">{money(sent)}</div><div className="s">{count(s?.traffic.sent ?? 0)} settlements</div></div>
      <div className="metric"><div className="k">Booked in the ledger</div><div className="v">{money(booked)}</div><div className="s">{count(rows)} rows</div></div>
      <div className={`metric ${missing > 0 && !inFlight ? 'bad' : missing > 0 ? 'warn' : ''}`}>
        <div className="k">{inFlight ? 'Not booked yet' : 'Missing'}</div><div className="v">{money(missing)}</div>
        <div className="s">{inFlight ? 'still on the topic' : missing > 0 ? 'sent but not in the ledger' : 'sent = booked'}</div>
      </div>
      <div className={`metric ${zero > 0 ? 'bad' : ''}`}><div className="k">Booked at £0.00</div><div className="v">{count(zero)}</div><div className="s">{zero > 0 ? 'no exception, no alert' : 'none'}</div></div>
      <div className={`metric ${lag > 0 ? 'warn' : ''}`}><div className="k">Backlog</div><div className="v">{count(lag)}</div><div className="s">events waiting on Kafka</div></div>
      <div className="metric"><div className="k">Dead-letter topic</div><div className="v">{count(dlt)}</div><div className="s">{dlt === 0 ? 'empty: nothing looked wrong' : 'records'}</div></div>
    </div>
  );
}

export function LogConsole() {
  const { store } = useStore();
  const body = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [showSvc, setShowSvc] = useState(true);
  const logs = showSvc ? store.logs : store.logs.filter((l) => l.level !== 'svc');

  useEffect(() => {
    if (follow && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [logs.length, follow]);

  return (
    <div className="console" aria-label="Log">
      <div className="console-head">
        <span>What's happening</span>
        <span className="row" style={{ gap: 10 }}>
          <label className="row" style={{ gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={showSvc} onChange={(e) => setShowSvc(e.target.checked)} /> service logs
          </label>
        </span>
      </div>
      <div
        className="console-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 30);
        }}
      >
        {logs.length === 0 && <div className="l-info">Nothing yet. Press Prepare, or start act 2.</div>}
        {logs.map((l, i) => (
          <div key={i} className={`l-${l.level}`}>
            {l.service && <span className={`svc-tag svc-${l.service}`}>{l.service.replace('-service', '')}</span>}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LedgerTable({ limit = 10 }: { limit?: number }) {
  const { store } = useStore();
  const l = store.state?.ledger;
  const seen = useRef<number>(0);
  const maxId = l?.last?.[0]?.id ?? 0;
  const prevMax = seen.current;
  useEffect(() => {
    seen.current = maxId;
  }, [maxId]);
  if (!l || !l.columns?.length) {
    return <p className="muted">No ledger yet: ledger-service creates the table when it first starts.</p>;
  }
  return (
    <table className="data">
      <thead>
        <tr>
          <th>#</th><th>Payment</th><th>Merchant</th><th className="num">Booked amount</th><th>Settled (UTC)</th>
        </tr>
      </thead>
      <tbody>
        {l.last.slice(0, limit).map((r) => (
          <tr key={r.id} className={`${r.amount === 0 ? 'zero' : ''} ${prevMax && r.id > prevMax ? 'fresh' : ''}`}>
            <td className="mono small">{r.id}</td>
            <td className="mono small">{r.payment}</td>
            <td>{r.merchant}</td>
            <td className="num">{money(r.amount)}</td>
            <td className="mono small">{r.settledUtc}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
