import { useFetch, useStore } from '../store';
import { shortRef } from '../components/Docks';
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

export default function Act5({ selected, setSelected }: { selected: string; setSelected: (k: string) => void }) {
  const { store } = useStore();
  const { data: refs } = useFetch<Refs>('/api/refs');
  const { data: saved } = useFetch<{ generated?: string; results: RollbackResult[] }>('/api/matrix', [store.matrixStamp]);
  const cases = refs?.cases ?? [];
  const busyKey = /^Rollback test (.+) → (.+)$/.exec(store.busy ?? '');
  const runningKey = busyKey ? `${busyKey[1]}→${busyKey[2]}` : store.busy?.startsWith('Rollback') ? store.lastRollbackKey : null;
  const resultFor = (key: string): RollbackResult | undefined =>
    store.rollback[key] ?? saved?.results.find((r) => `${r.from}→${r.to}` === key);

  const pick = (key: string) => {
    setSelected(key);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      <div className="card card-dark">
        <div className="eyebrow">Act 5 · The proof</div>
        <h1>Each row deploys for real, rolls back, and checks the money</h1>
        <p className="lede">
          Pick a row and press <b>Run this row</b> in the panel under the map. It starts clean at the old version, deploys
          ledger-service then settlement-service at the new one, then rolls each back. The database keeps the new
          migration throughout. After every stage it sends 20 settlements and checks six things, live.
        </p>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <div className="eyebrow">Rollback matrix</div>
            <h2>Four passes, one fail</h2>
          </div>
          <span className="small muted">Click a row to show it in the panel above.</span>
        </div>
        <table className="matrix" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Old → new</th>
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
                <tr key={key} className={key === (runningKey ?? selected) ? 'selected' : ''} onClick={() => pick(key)} style={{ cursor: 'pointer' }}>
                  <td className="case">{key === (runningKey ?? selected) ? '▸ ' : ''}{shortRef(c.from)} → {shortRef(c.to)}</td>
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
        <p className="small muted" style={{ marginTop: 10 }}>
          {saved?.generated ? `Last full run: ${saved.generated}. ` : ''}PR #482 fails at stage 2, <i>before</i> anyone presses
          rollback: a new consumer reading old events books zero too.
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
