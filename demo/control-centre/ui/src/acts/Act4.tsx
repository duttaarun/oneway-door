import { useFetch } from '../store';

interface SplitStep {
  ref: string;
  exists: boolean;
  subject?: string;
  body?: string;
  diffStat?: string;
  files?: string[];
}

const PHASES = [
  { n: 1, name: 'Expand', colour: '#11B67A', back: 'v1 ignores the new column and the unknown field; amount is still sent and written.' },
  { n: 2, name: 'Migrate', colour: '#00864F', back: 'Step 1 already writes both columns, so its code is happy with the backfill.' },
  { n: 3, name: 'Contract', colour: '#006A4D', back: 'A trigger keeps amount correct for step 2. settlement still sends amount.' },
  { n: 4, name: 'Drop', colour: '#024731', back: 'Step 3 code never touches amount, so removing it changes nothing it reads.' },
];

export default function Act4() {
  const { data, error } = useFetch<{ steps: SplitStep[]; sameEndState: boolean }>('/api/story/act4');
  return (
    <>
      <div className="card card-dark">
        <div className="eyebrow">Act 4 · The split</div>
        <h1>Same destination, four doors that swing both ways</h1>
        <p className="lede">
          The skill proposes expand → migrate → contract → drop, and can generate it. These four branches are what it
          produced. Every commit says why it rolls back to the one before.
        </p>
        <div className="split-compare">
          <div className="door one">
            <div className="t">PR #482</div>
            <div>One step. One-way: the old code can't run against what it leaves behind.</div>
          </div>
          <div className="door two">
            <div className="t">The split</div>
            <div>
              Four steps. Each one is two-way: deploy it, roll it back, and the previous step runs fine against the new
              state.{' '}
              {data && (data.sameEndState
                ? <b>Same end state as PR #482: the contract and settlement-service are identical.</b>
                : <b>Not the same end state as PR #482.</b>)}
            </div>
          </div>
        </div>
      </div>
      {error && <div className="card"><p className="muted">Couldn't read git: {error}</p></div>}
      <div className="split-cards">
        {PHASES.map((p, i) => {
          const s = data?.steps[i];
          return (
            <div className="split-card" key={p.n} style={{ borderTopColor: p.colour }}>
              {i > 0 && <span className="arrow-back" title="rolls back to the previous step">⇆</span>}
              <div className="row between">
                <span className="n">{p.n}</span>
                <span className="chip chip-green">rolls back ✓</span>
              </div>
              <div className="ph">{p.name}</div>
              <code className="small">{s?.ref ?? '…'}</code>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>{s?.subject?.replace(/^Split \d\/4 \(\w+\): /, '') ?? ''}</div>
              <div className="why"><b>Why it rolls back:</b> {p.back}</div>
              <div className="files">{s?.diffStat}</div>
              <details>
                <summary className="small" style={{ cursor: 'pointer' }}>Commit message</summary>
                <pre className="small" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--body)', margin: '6px 0 0' }}>{s?.body}</pre>
              </details>
            </div>
          );
        })}
      </div>
    </>
  );
}
