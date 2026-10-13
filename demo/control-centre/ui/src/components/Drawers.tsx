import { useState } from 'react';
import { useFetch, useStore } from '../store';
import type { Refs } from '../types';

export function ControlRoom({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const { post, store, mode } = useStore();
  const { data: refs } = useFetch<Refs>('/api/refs');
  const [service, setService] = useState('ledger-service');
  const [ref, setRef] = useState('main');
  const [n, setN] = useState(20);
  const [startRef, setStartRef] = useState('main');
  const busy = !!store.busy || mode === 'replay';
  const run = async (path: string, body?: unknown) => {
    const r = await post(path, body);
    if (!r.ok) toast(r.message ?? 'Failed');
  };

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Control room">
        <div className="row between">
          <h2>Control room</h2>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
        <p className="small muted">Everything here is real. Each action queues on the Control Centre and reports in the log.</p>
        {mode === 'replay' && <p className="problem">Replay mode: switch to Live to run things.</p>}

        <section>
          <h3>Deploy or roll back one service</h3>
          <div className="row">
            <select value={service} onChange={(e) => setService(e.target.value)}>
              {(refs?.services ?? []).map((s) => <option key={s}>{s}</option>)}
            </select>
            <select value={ref} onChange={(e) => setRef(e.target.value)}>
              {(refs?.refs ?? []).map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div><button className="btn btn-black" disabled={busy} onClick={() => run('/deploy', { service, ref })}>Build and deploy</button></div>
        </section>

        <section>
          <h3>Traffic and checks</h3>
          <div className="row">
            <input type="number" min={1} max={500} value={n} onChange={(e) => setN(Number(e.target.value))} style={{ width: 90 }} />
            <button className="btn btn-black" disabled={busy} onClick={() => run('/traffic', { count: n })}>Send settlements</button>
          </div>
          <div className="row">
            <button className="btn btn-ghost" disabled={busy} onClick={() => run('/recon')}>Run reconciliation</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => run('/hotfix')}>Apply V42 hotfix</button>
          </div>
        </section>

        <section>
          <h3>Whole stack</h3>
          <div className="row">
            <select value={startRef} onChange={(e) => setStartRef(e.target.value)}>
              {(refs?.refs ?? []).map((r) => <option key={r}>{r}</option>)}
            </select>
            <button className="btn btn-black" disabled={busy} onClick={() => run('/up', { ref: startRef })}>Fresh start at this ref</button>
          </div>
          <div className="row">
            <button className="btn btn-ghost" disabled={busy} onClick={() => run('/prepare')}>Prepare (build all, v1 + 10)</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => run('/down')}>Stop all and wipe</button>
          </div>
        </section>

        <section>
          <h3>Replay recording</h3>
          <p className="small muted">Runs the whole incident live and saves it to <code>demo/control-centre/recordings/incident.json</code>. Replay mode plays that file, so do this once on the presenting laptop.</p>
          <div><button className="btn btn-ghost" disabled={busy} onClick={() => run('/incident/record')}>Record the incident (about 40 s)</button></div>
        </section>
      </aside>
    </div>
  );
}

interface Check {
  ok: boolean;
  version?: string;
  note?: string;
  missing?: string[];
  status?: string;
  failure?: string;
}

export function SystemCheck({ onClose }: { onClose: () => void }) {
  const { data, reload } = useFetch<Record<string, Check | string>>('/api/env');
  const rows: [string, string][] = [
    ['java', 'Java 21+'], ['git', 'git'], ['branches', 'Demo branches'], ['infra', 'Postgres + Kafka'],
    ['mavenCentral', 'Maven Central'], ['node', 'Node (act 3)'],
  ];
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="System check">
        <div className="row between">
          <h2>System check</h2>
          <div className="row">
            <button className="btn btn-ghost" onClick={reload}>Check again</button>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <p className="small muted">{data ? `${data.os as string} · repo at ${data.root as string}` : 'Checking…'}</p>
        <div>
          {rows.map(([key, label]) => {
            const c = data?.[key] as Check | undefined;
            const optional = key === 'node';
            return (
              <div className="check-row" key={key}>
                <span className={`tick ${!c ? 'wait' : c.ok ? 'ok' : optional ? 'wait' : 'bad'}`}>{!c ? '·' : c.ok ? '✓' : optional ? '–' : '✗'}</span>
                <b>{label}</b>
                <div className="small">
                  {c?.version && c.version !== 'null' ? <div className="mono">{c.version}</div> : null}
                  {c?.status && <div>{c.status}{c.failure && c.failure !== 'null' ? `: ${c.failure}` : ''}</div>}
                  {c?.missing && c.missing.length > 0 && <div>Missing: {c.missing.join(', ')}</div>}
                  {c?.note && <div className="muted">{c.note}</div>}
                </div>
              </div>
            );
          })}
        </div>
        <p className="small muted">
          Run this the day before, on the laptop you'll present from. Then press Prepare: it builds every branch once, so
          nothing compiles on stage.
        </p>
      </aside>
    </div>
  );
}
