import { useEffect } from 'react';
import { useFetch, useStore } from '../store';
import { count, money } from '../format';
import { LedgerTable } from '../components/Rail';
import type { Refs } from '../types';

export default function Act2() {
  const { store, post, mode, replayNext, replayAll, replayRestart, replayPlaying, replayStep, recording } = useStore();
  const { data: refs } = useFetch<Refs>('/api/refs');
  const steps = refs?.incidentSteps ?? [];
  const total = steps.length || 7;
  const live = mode === 'live';

  // Which step is next / running, from the step events (live or replayed).
  const statuses = store.steps;
  const runningIdx = Object.values(statuses).find((s) => s.status === 'running')?.index ?? -1;
  const doneCount = Object.values(statuses).filter((s) => s.status === 'done').length;
  const failedIdx = Object.values(statuses).find((s) => s.status === 'failed')?.index ?? -1;
  const nextIdx = live ? (failedIdx >= 0 ? failedIdx : Math.min(doneCount, total)) : Math.min(replayStep, total);
  // The narrator shows the step that is running, or else the last one that ran: where the story is now.
  const current = runningIdx >= 0 ? runningIdx : failedIdx >= 0 ? failedIdx : doneCount - 1;
  const shown = current >= 0 ? statuses[current] ?? null : null;
  const finished = doneCount >= total;
  const result = statuses[total - 1]?.result ?? store.state?.incident.result ?? null;
  const busy = !!store.busy || replayPlaying;

  const next = () => (live ? post('/incident/next') : replayNext());
  const autoplay = () => (live ? post('/incident/autoplay') : replayAll());
  const restart = () => (live ? post('/incident/restart') : replayRestart());

  // Right arrow or space runs the next step: handy with a presentation clicker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        if (!busy && !finished) next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <div className="card">
        <div className="row between">
          <div>
            <div className="eyebrow">Act 2 · The incident, for real</div>
            <h1>Friday afternoon, 16:30 to 17:26</h1>
          </div>
          <div className="row">
            {!live && recording && <span className="chip chip-v2">replay · recorded {new Date(recording.recordedAt).toLocaleString('en-GB')}</span>}
            <button className="btn btn-ghost" onClick={restart} disabled={busy}>Restart</button>
            <button className="btn btn-ghost" onClick={autoplay} disabled={busy || finished}>Play all</button>
          </div>
        </div>
        <p className="lede">
          {live
            ? 'Every step runs for real: builds from git, a rollback to the previous commit, a hand-written hotfix, and real settlements through Kafka into Postgres. Nothing on this screen is mocked.'
            : 'A recording of a real run on this laptop: the same builds, rollback, hotfix and settlements, played back with their original timing.'}
        </p>

        <div className="steps" role="list">
          {steps.map((st, i) => {
            const ev = statuses[i];
            const cls = ev?.status === 'running' ? 'running' : ev?.status === 'done' ? 'done' : ev?.status === 'failed' ? 'failed' : i === nextIdx && !busy ? 'next' : '';
            return (
              <div key={st.id} className={`step ${cls}`} role="listitem">
                <div className="time">
                  <span>{st.time}</span>
                  {ev?.status === 'running' && <span className="spinner" />}
                  {ev?.status === 'done' && <span>✓</span>}
                  {ev?.status === 'failed' && <span>✗</span>}
                </div>
                <div className="title">{st.title}</div>
              </div>
            );
          })}
        </div>

        <div className="narrator">
          <div>
            <div className="small" style={{ color: 'var(--green-bright)', fontWeight: 700 }}>
              {shown ? `Step ${current + 1} of ${total} · ${shown.time}` : `${total} steps · about 40 seconds of real work`}
            </div>
            <div className="cap">{shown?.caption ?? 'Northwind Payments runs v1. PR #482 is about to ship.'}</div>
            {!shown && <div className="hint">Watch the map above: every dot is a real settlement on Kafka.</div>}
            {shown?.say && <div className="say">{shown.say}</div>}
          </div>
          <div className="controls">
            <button className="btn btn-green btn-big" onClick={next} disabled={busy || finished}>
              {runningIdx >= 0 || replayPlaying ? <><span className="spinner" /> Running</> : finished ? 'Done' : nextIdx === 0 ? 'Start ▸' : `Run step ${nextIdx + 1} ▸`}
            </button>
            <span className="small" style={{ color: '#B9D9CB', textAlign: 'center' }}>or press <span className="kbd">→</span></span>
          </div>
        </div>

        {finished && result && (
          <div className={`verdict ${result.reproduced ? '' : 'good'}`}>
            <div className="big">{money(result.missing)}</div>
            <div>
              <div style={{ fontFamily: 'var(--head)', fontSize: 22, fontWeight: 700 }}>is missing, and every dashboard is green.</div>
              <div className="facts" style={{ marginTop: 6 }}>
                <span><b>{count(result.zeroRows)}</b> settlements booked at £0.00</span>
                <span>dead-letter topic: <b>{count(result.dlt)}</b></span>
                <span>ledger-service: <b>{result.ledgerHealth}</b></span>
                <span>sent <b>{money(result.sent)}</b>, booked <b>{money(result.booked)}</b></span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <div className="eyebrow">The ledger, live</div>
            <h3>Last 10 entries in <code>ledger_entries</code></h3>
          </div>
          {live && (
            <div className="row">
              <button className="btn btn-ghost" disabled={busy} onClick={() => post('/traffic', { count: 10 })}>Send 10 settlements</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => post('/recon')}>Run reconciliation</button>
            </div>
          )}
        </div>
        <LedgerTable />
      </div>
    </>
  );
}
