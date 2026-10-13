import { useEffect } from 'react';
import { useFetch, useStore } from '../store';
import { count, money } from '../format';
import type { Refs, RollbackResult, StageRow } from '../types';

// Controls that sit inside the green map band, right under the map, so the presenter drives the story and watches
// it happen without scrolling. Act 2 gets the incident steps; act 5 gets the live rollback test.

/* ------------------------------------------------------------------ act 2 */

export function IncidentDock() {
  const { store, post, mode, replayNext, replayAll, replayRestart, replayPlaying, replayStep } = useStore();
  const { data: refs } = useFetch<Refs>('/api/refs');
  const steps = refs?.incidentSteps ?? [];
  const total = steps.length || 7;
  const live = mode === 'live';

  const statuses = store.steps;
  const runningIdx = Object.values(statuses).find((s) => s.status === 'running')?.index ?? -1;
  const doneCount = Object.values(statuses).filter((s) => s.status === 'done').length;
  const failedIdx = Object.values(statuses).find((s) => s.status === 'failed')?.index ?? -1;
  const nextIdx = live ? (failedIdx >= 0 ? failedIdx : Math.min(doneCount, total)) : Math.min(replayStep, total);
  const current = runningIdx >= 0 ? runningIdx : failedIdx >= 0 ? failedIdx : doneCount - 1;
  const shown = current >= 0 ? statuses[current] ?? null : null;
  const finished = doneCount >= total;
  const result = statuses[total - 1]?.result ?? store.state?.incident.result ?? null;
  const busy = !!store.busy || replayPlaying;

  const next = () => (live ? post('/incident/next') : replayNext());
  const autoplay = () => (live ? post('/incident/autoplay') : replayAll());
  const restart = () => (live ? post('/incident/restart') : replayRestart());

  // Right arrow, space or a presentation clicker runs the next step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') && !e.metaKey && !e.ctrlKey
          && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        if (!busy && !finished) next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="dock" aria-label="Incident controls">
      <div className="dock-top">
        <div className="dsteps" role="list">
          {steps.map((st, i) => {
            const ev = statuses[i];
            const cls = ev?.status === 'running' ? 'running' : ev?.status === 'done' ? 'done' : ev?.status === 'failed' ? 'failed'
              : i === nextIdx && !busy && !finished ? 'next' : '';
            return (
              <div key={st.id} className={`dstep ${cls}`} role="listitem">
                <span className="t">{st.time}{ev?.status === 'running' && <span className="spinner" />}{ev?.status === 'done' && ' ✓'}{ev?.status === 'failed' && ' ✗'}</span>
                <span className="n">{st.title}</span>
              </div>
            );
          })}
        </div>
        <div className="dbtns">
          <button className="btn btn-ghost-light" onClick={restart} disabled={busy}>Restart</button>
          <button className="btn btn-ghost-light" onClick={autoplay} disabled={busy || finished}>Play all</button>
          <button className="btn btn-green btn-big" onClick={next} disabled={busy || finished}>
            {runningIdx >= 0 || replayPlaying ? <><span className="spinner" /> Running</> : finished ? 'Done' : nextIdx === 0 ? 'Start ▸' : `Run step ${nextIdx + 1} ▸`}
          </button>
        </div>
      </div>
      <div className="dock-main">
        {finished && result ? (
          <div className="dverdict">
            <span className="big">{money(result.missing)}</span>
            <div>
              <div className="cap">is missing, and every dashboard is green.</div>
              <div className="facts">
                <span><b>{count(result.zeroRows)}</b> booked at £0.00</span>
                <span>DLT <b>{count(result.dlt)}</b></span>
                <span>ledger <b>{result.ledgerHealth}</b></span>
                <span>sent <b>{money(result.sent)}</b> · booked <b>{money(result.booked)}</b></span>
              </div>
            </div>
          </div>
        ) : (
          <div className="dnarr">
            <div className="lbl">{shown ? `Step ${current + 1} of ${total} · ${shown.time}` : `${total} steps · press Start or →`}</div>
            <div className="cap">{shown?.caption ?? 'Northwind Payments runs v1. PR #482 is about to ship.'}</div>
            {shown?.say ? <div className="say">“{shown.say}”</div> : <div className="hint">Every dot above is a real settlement on Kafka.</div>}
          </div>
        )}
        <DockMetrics />
      </div>
    </div>
  );
}

function DockMetrics() {
  const { store } = useStore();
  const s = store.state;
  const sent = s?.traffic.total ?? 0;
  const booked = s?.ledger?.booked ?? 0;
  const lag = s?.kafka?.lag ?? 0;
  const zero = s?.ledger?.zero ?? 0;
  const dlt = s?.kafka?.dlt ?? 0;
  const missing = Math.max(0, Math.round((sent - booked) * 100) / 100);
  return (
    <div className="dmetrics" aria-label="Live numbers">
      <div className="dm"><span className="k">Sent</span><span className="v">{money(sent)}</span></div>
      <div className="dm"><span className="k">Booked</span><span className="v">{money(booked)}</span></div>
      <div className={`dm ${missing > 0 ? (lag > 0 ? 'warn' : 'bad') : ''}`}><span className="k">{lag > 0 ? 'Not booked yet' : 'Missing'}</span><span className="v">{money(missing)}</span></div>
      <div className={`dm ${zero > 0 ? 'bad' : ''}`}><span className="k">At £0.00</span><span className="v">{count(zero)}</span></div>
      <div className={`dm ${lag > 0 ? 'warn' : ''}`}><span className="k">Backlog</span><span className="v">{count(lag)}</span></div>
      <div className="dm"><span className="k">Dead letters</span><span className="v">{count(dlt)}</span></div>
    </div>
  );
}

/* ------------------------------------------------------------------ act 5 */

const STAGE_NAMES = ['Baseline', 'Deploy ledger', 'Deploy settlement', 'Roll back ledger', 'Roll back settlement'];
// Which side each service is on at each stage, and whether the database already carries the new migration.
const PLAN: ['old' | 'new', 'old' | 'new', boolean][] = [['old', 'old', false], ['new', 'old', true], ['new', 'new', true], ['old', 'new', true], ['old', 'old', true]];

export function shortRef(ref: string): string {
  if (ref === 'main') return 'main';
  if (ref.startsWith('pr-482')) return 'PR #482';
  const m = /^split\/(\d)-/.exec(ref);
  return m ? `split ${m[1]}` : ref;
}

interface Check { label: string; ok: boolean; value: string }

export function checksFor(st: StageRow): Check[] {
  const down = (who: string) => st.problems.some((p) => p.includes(`${who} is`));
  const lh = st.ledgerHealth ?? (down('ledger-service') ? 'DOWN' : 'UP');
  const sh = st.settlementHealth ?? (down('settlement-service') ? 'DOWN' : 'UP');
  const reconOk = st.recon !== 'error' && !st.recon.includes('≠') && !(st.mismatches && st.mismatches > 0);
  const reconValue = st.recon === 'error'
    ? (st.reconError ? `error: ${st.reconError.replace(/^ERROR: /, '')}` : 'error')
    : st.recon.includes('≠') ? st.recon : `${st.recon} = sent`;
  return [
    { label: 'Both services healthy', ok: lh === 'UP' && sh === 'UP', value: `ledger ${lh} · settlement ${sh}` },
    { label: 'Every settlement booked once', ok: st.rows === st.expectedRows, value: `${st.rows} of ${st.expectedRows}` },
    { label: 'Nothing at £0.00', ok: st.zero === 0, value: `${st.zero} rows` },
    { label: 'Dead-letter topic empty', ok: st.dlt === 0, value: `${st.dlt}` },
    { label: 'No backlog on Kafka', ok: st.lag === 0, value: `${st.lag} waiting` },
    { label: 'Reconciliation matches', ok: reconOk, value: reconValue },
  ];
}

export function ProofDock({ selected, setSelected }: { selected: string; setSelected: (k: string) => void }) {
  const { store, post, mode } = useStore();
  const { data: refs } = useFetch<Refs>('/api/refs');
  const { data: saved } = useFetch<{ generated?: string; results: RollbackResult[] }>('/api/matrix', [store.matrixStamp]);
  const cases = refs?.cases ?? [];
  const runningTest = store.busy?.startsWith('Rollback') ?? false;
  const runningAll = store.busy === 'Rollback matrix';
  // While a test runs, follow it; otherwise show the row the presenter picked.
  const busyKey = /^Rollback test (.+) → (.+)$/.exec(store.busy ?? '');
  const key = runningTest ? (busyKey ? `${busyKey[1]}→${busyKey[2]}` : store.lastRollbackKey ?? selected) : selected;
  const [from, to] = key.split('→');
  const r: RollbackResult | undefined = store.rollback[key] ?? saved?.results.find((x) => `${x.from}→${x.to}` === key);
  const live = r?.result === 'running';
  const caseIdx = cases.findIndex((c) => `${c.from}→${c.to}` === key);
  const busy = !!store.busy || mode === 'replay';
  const doneStages = r?.stages.length ?? 0;

  return (
    <div className="dock" aria-label="Rollback test">
      <div className="dock-top">
        <div className="ptitle">
          <span className="lbl">{runningAll ? `Rollback matrix · row ${caseIdx + 1} of ${cases.length}` : 'Rollback test'}</span>
          <span className="case"><b>{shortRef(from)}</b> → <b>{shortRef(to)}</b> <code>{from} → {to}</code></span>
          {r && (
            <span className={`pstatus ${live ? 'run' : r.result === 'PASS' ? 'pass' : 'fail'}`}>
              {live ? <><span className="spinner" /> stage {Math.min(doneStages + 1, 5)} of 5</> : r.result}
            </span>
          )}
        </div>
        <div className="dbtns">
          <select aria-label="Row of the matrix" value={key} disabled={runningTest} onChange={(e) => setSelected(e.target.value)}>
            {cases.map((c) => <option key={`${c.from}→${c.to}`} value={`${c.from}→${c.to}`}>{shortRef(c.from)} → {shortRef(c.to)}</option>)}
          </select>
          <button className="btn btn-green" disabled={busy} onClick={() => post('/rollback-test', { from, to })}>Run this row ▸</button>
          <button className="btn btn-ghost-light" disabled={busy} onClick={() => post('/matrix')}>Run all 5 rows</button>
        </div>
      </div>

      <div className="pstages">
        {PLAN.map(([l, s, db], i) => {
          const st = r?.stages.find((x) => x.index === i);
          const cur = live && r?.current?.index === i && !st ? r.current : null;
          const state = st ? (st.ok ? 'ok' : 'bad') : cur ? 'run' : 'wait';
          const ver = (side: 'old' | 'new') => (side === 'old' ? shortRef(from) : shortRef(to));
          return (
            <div key={i} className={`pst ${state}`}>
              <div className="pst-h">
                <span className="num">{i + 1}</span>
                <span className="nm">{STAGE_NAMES[i]}</span>
                <span className="ic">{state === 'ok' ? '✓' : state === 'bad' ? '✗' : state === 'run' ? <span className="spinner" /> : ''}</span>
              </div>
              <div className="vers">
                <span className={`vb ${l}`}>ledger {ver(l)}</span>
                <span className={`vb ${s}`}>settlement {ver(s)}</span>
                <span className={`vb ${db ? 'db1' : 'db0'}`}>{db ? `DB has ${shortRef(to)}'s migration` : 'DB: old schema'}</span>
              </div>
              {cur && (
                <div className="psteps">
                  <div className="act">{cur.action}</div>
                  {cur.steps.map((x) => (
                    <div key={x.id} className={`pstep ${x.status}`}>
                      <span>{x.status === 'running' ? <span className="spinner" /> : x.status === 'ok' ? '✓' : '✗'}</span>
                      <span>{x.text.replace(/[\w.$]+(Exception|Error): /g, '')}</span>
                    </div>
                  ))}
                </div>
              )}
              {st && (
                <div className="pchecks">
                  {checksFor(st).map((c) => (
                    <div key={c.label} className={`pc ${c.ok ? 'ok' : 'bad'}`} title={c.label}>
                      <span>{c.ok ? '✓' : '✗'}</span><span className="l">{c.label}</span><span className="v">{c.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {!st && !cur && <div className="pwait">{live ? 'waiting…' : 'not run yet'}</div>}
            </div>
          );
        })}
      </div>
      <div className="pfoot">
        {live && r?.current ? <span>Now: <b>{r.current.action}</b></span>
          : r?.result === 'FAIL' ? <span className="bad">✗ {r.firstProblem}</span>
          : r?.result === 'PASS' ? <span className="good">✓ Deploys and rolls back with every check green at every stage.</span>
          : <span>Press <b>Run this row</b> to deploy, roll back and check this step for real.</span>}
        {!live && saved?.generated && !store.rollback[key] && <span className="muted-d">from the last full run, {saved.generated}</span>}
      </div>
    </div>
  );
}
