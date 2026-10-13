import { useMemo, useState } from 'react';
import { marked } from 'marked';
import { useFetch, useStore } from '../store';
import { count } from '../format';

interface Finding {
  file: string;
  line: number;
  pattern: string;
  object: string;
  severity: string;
  detail: string;
}

interface Act3Data {
  oneWay: string;
  twoWay: string;
  skillPath: string;
  node: string | null;
  scanMigrations?: { findings?: Finding[]; error?: string };
  schemaCompat?: { findings?: Finding[]; error?: string };
}

function render(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true }) as string;
  return html
    .replace('<strong>Verdict: ONE-WAY</strong>', '<strong class="verdict-chip">Verdict: ONE-WAY</strong>')
    .replace('<strong>Verdict: TWO-WAY</strong>', '<strong class="verdict-chip" style="background:#006A4D">Verdict: TWO-WAY</strong>');
}

export default function Act3() {
  const { data, error } = useFetch<Act3Data>('/api/story/act3');
  const { store } = useStore();
  const [tab, setTab] = useState<'review' | 'scripts' | 'two'>('review');
  const oneWay = useMemo(() => render(data?.oneWay ?? ''), [data?.oneWay]);
  const twoWay = useMemo(() => render(data?.twoWay ?? ''), [data?.twoWay]);

  // What act 2 actually showed, read from this session's log and the incident result.
  const startupFail = store.logs.find((l) => l.level === 'fail' && /Schema-validation/.test(l.text))?.text.trim().replace(/^.*?(Schema-validation)/, '$1');
  const reconFail = store.logs.find((l) => /reconciliation-batch: .*column "amount" does not exist/.test(l.text))?.text.replace(/^✘ /, '');
  const result = store.steps[6]?.result ?? store.state?.incident.result;
  const findings = [...(data?.scanMigrations?.findings ?? []), ...(data?.schemaCompat?.findings ?? [])];

  return (
    <>
      <div className="card card-dark">
        <div className="eyebrow">Act 3 · Rewind, and ask Copilot</div>
        <h1>Before the merge, one question: can we roll back?</h1>
        <div className="row" style={{ marginTop: 14, alignItems: 'flex-start' }}>
          <span className="avatar" style={{ background: 'var(--green-bright)', color: '#000' }}>You</span>
          <div style={{ background: 'rgba(255,255,255,.1)', borderRadius: 12, padding: '10px 14px', fontSize: 16.5, maxWidth: 760 }}>
            Review the <code>pr-482-minor-units</code> branch against <code>main</code>. If this goes wrong after deploy, can we roll back?
          </div>
        </div>
        <p className="lede" style={{ marginTop: 12 }}>
          The <b>one-way-door</b> skill is one folder in <code>.github/skills</code>. Two small offline scripts check the
          migrations and the event schema. Copilot does the judgement: who else reads this column, and what the old code
          does with the new state.
        </p>
      </div>

      {error && <div className="card"><p className="muted">Couldn't load the review: {error}</p></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)', gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="subtabs" style={{ marginTop: 0 }}>
            <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>Copilot's review of PR #482</button>
            <button className={tab === 'scripts' ? 'on' : ''} onClick={() => setTab('scripts')}>Script findings ({findings.length})</button>
            <button className={tab === 'two' ? 'on' : ''} onClick={() => setTab('two')}>A TWO-WAY result</button>
          </div>
          {tab !== 'scripts' && (
            <div className="pr-comment">
              <div className="pr-comment-head">
                <span className="avatar">C</span>
                <b>GitHub Copilot</b>
                <span className="muted">used <code>{data?.skillPath ?? '.github/skills/one-way-door/SKILL.md'}</code></span>
              </div>
              <div className="md" dangerouslySetInnerHTML={{ __html: tab === 'review' ? oneWay : twoWay }} />
            </div>
          )}
          {tab === 'scripts' && (
            <div>
              <p className="small muted" style={{ marginBottom: 8 }}>
                {data?.node
                  ? <>Run just now with Node {data.node}: <code>scan-migrations.mjs</code> and <code>schema-compat.mjs</code>, <code>--base main --head pr-482-minor-units</code>. Deterministic, offline, JSON out.</>
                  : <>Node isn't installed here, so the scripts didn't run. Copilot runs them on the developer's machine; the review on the first tab is the skill's own worked example.</>}
              </p>
              {findings.map((f, i) => (
                <div className="finding" key={i}>
                  <span className="pattern">{f.pattern}</span>
                  <div>
                    <div><code>{f.object}</code> · {f.detail}</div>
                    <div className="small muted mono">{f.file}:{f.line}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="eyebrow">It predicted act 2</div>
          <h2>Three findings, three things we just watched</h2>
          <div style={{ marginTop: 10 }}>
            <Prediction n={1} q={<>v1 ledger-service <b>fails start-up</b> after V3: there is no undo.</>} seen={startupFail} />
            <Prediction n={2} q={<><b>reconciliation-batch</b>, not in this PR, breaks the moment V3 runs.</>} seen={reconFail} />
            <Prediction
              n={3}
              q={<>A v1 ledger books v2 events at <b>£0.00, silently</b>. No exception, nothing in the DLT.</>}
              seen={result ? `${count(result.zeroRows)} rows at £0.00 · DLT ${count(result.dlt)} · ledger ${result.ledgerHealth}` : undefined}
            />
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Red lines are copied from this session's run in act 2, not typed in.
          </p>
        </div>
      </div>
    </>
  );
}

function Prediction({ n, q, seen }: { n: number; q: React.ReactNode; seen?: string }) {
  return (
    <div className="prediction">
      <span className={`tick ${seen ? 'bad' : 'wait'}`}>{n}</span>
      <div>
        <div className="q">{q}</div>
        {seen ? <div className="seen">{seen}</div> : <div className="unseen">Run act 2 to see it happen.</div>}
      </div>
    </div>
  );
}
