import { useState } from 'react';
import { useFetch, useStore } from '../store';
import type { Refs, RollbackResult, StageRow } from '../types';

const STAGE_LABELS = ['Baseline', 'Deploy ledger', 'Deploy settlement', 'Roll back ledger', 'Roll back settlement'];

function cellNote(st: StageRow): string {
  if (st.ok) return `${st.rows}/${st.expectedRows}`;
  if (st.zero > 0) return `${st.zero} at £0`;
  if (st.lag > 0) return `${st.lag} stuck`;
  if (st.recon === 'error') return 'recon error';
  if (st.dlt > 0) return `${st.dlt} in DLT`;
  return 'problem';
}

export default function Act5() {
  const { store, post, mode } = useStore();
  const { data: refs } = useFetch<Refs>('/api/refs');
  const { data: saved } = useFetch<{ generated?: string; results: RollbackResult[] }>('/api/matrix', [store.matrixStamp]);
  const cases = refs?.cases ?? [];
  const [selected, setSelected] = useState('split/2-migrate→split/3-contract');
  const busy = !!store.busy;

  const resultFor = (key: string): RollbackResult | undefined =>
    store.rollback[key] ?? saved?.results.find((r) => `${r.from}→${r.to}` === key);
  const sel = resultFor(selected);
  const [from, to] = selected.split('→');

  return (
    <>
      <div className="card card-dark">
        <div className="eyebrow">Act 5 · The proof</div>
        <h1>Each row deploys for real, rolls back, and checks the money</h1>
        <p className="lede">
          Clean start at <i>from</i>. Deploy ledger-service, then settlement-service, at <i>to</i>. Roll ledger-service back,
          then settlement-service. After every step: 20 settlements, then check both services are healthy, every settlement
          is booked once, nothing is at £0.00, the DLT is empty and reconciliation matches.
        </p>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <div className="eyebrow">Rollback matrix</div>
            <h2>Four passes, one fail</h2>
          </div>
          <div className="row">
            <button className="btn btn-black" disabled={busy || mode === 'replay'} onClick={() => post('/rollback-test', { from, to })}>
              Run this row live
            </button>
            <button className="btn btn-ghost" disabled={busy || mode === 'replay'} onClick={() => post('/matrix')}>Run all (about 2 min)</button>
          </div>
        </div>
        <table className="matrix" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>From → to</th>
              {STAGE_LABELS.map((s, i) => <th key={s}>{i + 1}. {s}</th>)}
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => {
              const key = `${c.from}→${c.to}`;
              const r = resultFor(key);
              const running = r?.result === 'running';
              return (
                <tr key={key} className={key === selected ? 'selected' : ''} onClick={() => setSelected(key)} style={{ cursor: 'pointer' }}>
                  <td className="case">{key === selected ? '▸ ' : ''}{c.from} → {c.to}</td>
                  {STAGE_LABELS.map((_, i) => {
                    const st = r?.stages.find((x) => x.index === i);
                    const isNext = running && !st && (r?.stages.length ?? 0) === i;
                    return (
                      <td key={i} className={`cell ${st ? (st.ok ? 'ok' : 'bad') : isNext ? 'run' : ''}`} title={st?.problems.join('\n')}>
                        {st ? (st.ok ? '✓' : '✗') : isNext ? <span className="spinner" style={{ display: 'inline-block' }} /> : '·'}
                        {st && <small>{cellNote(st)}</small>}
                      </td>
                    );
                  })}
                  <td className={`res ${r?.result === 'PASS' ? 'pass' : r?.result === 'FAIL' ? 'fail' : ''}`}>
                    {running ? '…' : r?.result ?? '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sel?.firstProblem && (
          <div className="problem">
            <b>{sel.from} → {sel.to}:</b> {sel.reasons.slice(0, 4).join(' · ')}
          </div>
        )}
        {sel && !sel.firstProblem && sel.result === 'PASS' && (
          <p className="small" style={{ marginTop: 12, color: 'var(--green)' }}>
            <b>{sel.from} → {sel.to}:</b> deploys and rolls back with no errors, no £0.00 rows, an empty DLT and correct totals.
          </p>
        )}
        <p className="small muted" style={{ marginTop: 10 }}>
          {saved?.generated ? `Last full run: ${saved.generated}. ` : ''}PR #482 fails <i>before</i> anyone presses rollback:
          a new consumer reading old events books zero too.
        </p>
      </div>

      <div className="card card-dark">
        <h2>One-Way Door: know before you merge whether you can roll back.</h2>
        <p className="lede">Copy one folder into your repo, or install it as a Copilot plugin. Needs git and Node 20+. No servers, no accounts.</p>
        <pre className="code" style={{ marginTop: 12 }}>cp -R .github/skills/one-way-door your-repo/.github/skills/</pre>
      </div>
    </>
  );
}
