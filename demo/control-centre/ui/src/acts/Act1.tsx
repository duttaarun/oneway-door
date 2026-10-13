import { useFetch, useStore } from '../store';
import { highlightDiff, highlightSql } from '../highlight';

interface Act1Data {
  ref: string;
  subject: string;
  body: string;
  diffStat: string;
  migration: string;
  eventDiff: string;
}

const SERVICES = ['settlement-service', 'ledger-service', 'reconciliation-batch'];

export default function Act1() {
  const { data, error } = useFetch<Act1Data>('/api/story/act1');
  const { store, post, mode } = useStore();
  const running = store.busy?.startsWith('Unit tests');

  return (
    <>
      <div className="card card-dark">
        <div className="eyebrow">Act 1 · The innocent PR</div>
        <h1>PR #482: {data?.subject?.replace(/^PR #482: /, '') ?? 'store settlement amounts in minor units'}</h1>
        <p className="lede">
          Northwind stores money as a <code>double</code>. That's a bug waiting to happen, so PR #482 moves to pence. It
          renames the column, converts the values and updates both services. Tests are green. You'd approve this.
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <span className="chip chip-dark mono">{data?.ref ?? 'pr-482-minor-units'}</span>
          <span className="chip chip-dark">ledger-service</span>
          <span className="chip chip-dark">settlement-service</span>
          <span className="chip chip-dark">contracts/events</span>
        </div>
      </div>

      {error && <div className="card"><p className="muted">Couldn't read git: {error}</p></div>}

      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="eyebrow">The migration</div>
          <h3 style={{ marginBottom: 10 }}>V3__amount_minor_units.sql</h3>
          <pre className="code" dangerouslySetInnerHTML={{ __html: highlightSql(data?.migration ?? '') }} />
          <p className="small muted" style={{ marginTop: 10 }}>
            Renames <code>amount</code> and rewrites every value in place, on start-up, through Flyway.
          </p>
        </div>
        <div className="card">
          <div className="row between">
            <div>
              <div className="eyebrow">The checks</div>
              <h3>Unit tests at {data?.ref ?? 'the PR'}</h3>
            </div>
            <button className="btn btn-black" disabled={!!store.busy || mode === 'replay'} onClick={() => post('/tests', { ref: data?.ref })}>
              {running ? <><span className="spinner" /> Running</> : 'Run tests'}
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            {SERVICES.map((svc) => {
              const t = store.tests[svc];
              const cls = !t ? 'wait' : t.status === 'running' ? 'wait' : t.ok ? 'ok' : 'bad';
              return (
                <div className="test-row" key={svc}>
                  <span className={`tick ${cls}`}>{!t ? '·' : t.status === 'running' ? <span className="spinner" /> : t.ok ? '✓' : '✗'}</span>
                  <div>
                    <div style={{ fontWeight: 700 }}>{svc}</div>
                    <div className="small muted">{t?.summary ?? (t?.status === 'running' ? 'running…' : 'not run yet')}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Real Maven builds in a git worktree at the PR's commit. Green, which is the point.</p>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="eyebrow">The event contract</div>
          <h3 style={{ marginBottom: 10 }}>payment-settled.schema.json</h3>
          <pre className="code" style={{ maxHeight: 320 }} dangerouslySetInnerHTML={{ __html: highlightDiff(data?.eventDiff ?? '') }} />
        </div>
        <div className="card">
          <div className="eyebrow">The diff</div>
          <h3 style={{ marginBottom: 10 }}>git diff --stat main...{data?.ref ?? ''}</h3>
          <pre className="code" style={{ maxHeight: 320 }} dangerouslySetInnerHTML={{ __html: highlightDiff(data?.diffStat ?? '') }} />
        </div>
      </div>
    </>
  );
}
