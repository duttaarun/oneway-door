import { useStore } from '../store';
import { LedgerTable } from '../components/Rail';

export default function Act2() {
  const { store, post, mode, recording, replayPlaying } = useStore();
  const live = mode === 'live';
  const busy = !!store.busy || replayPlaying;
  return (
    <>
      <div className="card">
        <div className="row between">
          <div>
            <div className="eyebrow">Act 2 · The incident, for real</div>
            <h1>Friday afternoon, 16:30 to 17:26</h1>
          </div>
          {!live && recording && <span className="chip chip-v2">replay · recorded {new Date(recording.recordedAt).toLocaleString('en-GB')}</span>}
        </div>
        <p className="lede">
          {live
            ? 'Drive it from the controls under the map: Start, then → for each step. Every step runs for real: builds from git, a rollback to the previous commit, a hand-written hotfix, and real settlements through Kafka into Postgres.'
            : 'A recording of a real run on this laptop: the same builds, rollback, hotfix and settlements, played back with their original timing. Use the controls under the map.'}
        </p>
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
