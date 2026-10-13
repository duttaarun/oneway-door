import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LogLine, Observed, RollbackResult, Snapshot, StepEvent, TestResult, WireEvent } from './types';

// Every view reads from one store, fed by one stream of events: live from /api/events, or played back from a
// recording in replay mode. The views can't tell the difference, which is the point of replay.

export const EVENT_TYPES = ['state', 'log', 'svc', 'clear', 'step', 'incident', 'observed', 'busy', 'stage',
  'rollbackTest', 'rtStage', 'rtStep', 'matrix', 'tests', 'recon', 'build'] as const;

export interface Store {
  state: Snapshot | null;
  logs: LogLine[];
  steps: Record<number, StepEvent>;
  busy: string | null;
  observed: Observed[];
  rollback: Record<string, RollbackResult>;
  lastRollbackKey: string | null;
  matrixStamp: number;
  tests: Record<string, TestResult>;
}

const initial: Store = {
  state: null, logs: [], steps: {}, busy: null, observed: [], rollback: {}, lastRollbackKey: null,
  matrixStamp: 0, tests: {},
};

type Action = { type: 'event'; ev: WireEvent } | { type: 'reset' };

const MAX_LOGS = 600;

function pushLog(logs: LogLine[], line: LogLine): LogLine[] {
  const next = logs.length >= MAX_LOGS ? logs.slice(logs.length - MAX_LOGS + 1) : logs.slice();
  next.push(line);
  return next;
}

function reduce(s: Store, a: Action): Store {
  if (a.type === 'reset') return initial;
  const { type, data, t } = a.ev;
  switch (type) {
    case 'state':
      return { ...s, state: data, busy: data.busy ?? null };
    case 'log':
      return { ...s, logs: pushLog(s.logs, { t, level: data.level, text: data.text }) };
    case 'svc':
      return { ...s, logs: pushLog(s.logs, { t, level: 'svc', text: data.text, service: data.service }) };
    case 'clear':
      return { ...s, logs: [] };
    case 'step': {
      const step = data as StepEvent;
      const steps = step.index === 0 && step.status === 'running' ? {} : { ...s.steps };
      steps[step.index] = step;
      return { ...s, steps };
    }
    case 'incident':
      return data.next === 0 ? { ...s, steps: {} } : s;
    case 'observed': {
      const observed = s.observed.length >= 400 ? s.observed.slice(-399) : s.observed.slice();
      if (observed.length && data.offset <= observed[observed.length - 1].offset) {
        // The topic was recreated: offsets start again.
        return { ...s, observed: [data] };
      }
      observed.push(data);
      return { ...s, observed };
    }
    case 'busy':
      return { ...s, busy: data.name ?? null };
    case 'stage': {
      const key = `${data.from}→${data.to}`;
      const prev = s.rollback[key] ?? { from: data.from, to: data.to, result: 'running', firstProblem: null, reasons: [], stages: [] };
      const stages = prev.stages.filter((x) => x.index !== data.index).concat([data]).sort((x, y) => x.index - y.index);
      return { ...s, rollback: { ...s.rollback, [key]: { ...prev, stages } }, lastRollbackKey: key };
    }
    case 'rollbackTest': {
      const key = `${data.from}→${data.to}`;
      return { ...s, rollback: { ...s.rollback, [key]: { ...data, current: null } }, lastRollbackKey: key };
    }
    case 'rtStage': {
      const key = `${data.from}→${data.to}`;
      const prev = s.rollback[key] ?? { from: data.from, to: data.to, result: 'running', firstProblem: null, reasons: [], stages: [] };
      const current = { index: data.index, stage: data.stage, ledgerRef: data.ledgerRef, settlementRef: data.settlementRef, action: data.action, steps: [] };
      return { ...s, rollback: { ...s.rollback, [key]: { ...prev, current } }, lastRollbackKey: key };
    }
    case 'rtStep': {
      const key = `${data.from}→${data.to}`;
      const prev = s.rollback[key];
      if (!prev?.current || prev.current.index !== data.index) return s;
      const steps = prev.current.steps.filter((x) => x.id !== data.id).concat([{ id: data.id, text: data.text, status: data.status }]);
      return { ...s, rollback: { ...s.rollback, [key]: { ...prev, current: { ...prev.current, steps } } } };
    }
    case 'matrix':
      return { ...s, matrixStamp: Date.now() };
    case 'tests':
      return { ...s, tests: { ...s.tests, [data.service]: data } };
    default:
      return s;
  }
}

// Raw event listeners (the system map animates from these without re-rendering the whole app).
type Listener = (ev: WireEvent) => void;
const listeners = new Set<Listener>();
export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface Recording {
  name: string;
  recordedAt: string;
  reproduced: boolean;
  events: WireEvent[];
}

interface Ctx {
  store: Store;
  mode: 'live' | 'replay';
  connected: boolean;
  recording: Recording | null;
  replayStep: number;
  replayPlaying: boolean;
  setMode: (m: 'live' | 'replay') => void;
  replayNext: () => void;
  replayAll: () => void;
  replayRestart: () => void;
  post: (path: string, body?: unknown) => Promise<{ ok: boolean; message?: string }>;
}

const StoreContext = createContext<Ctx | null>(null);

export function useStore(): Ctx {
  const c = useContext(StoreContext);
  if (!c) throw new Error('StoreProvider missing');
  return c;
}

/** Splits a recording into the preamble and one segment per incident step. */
function segments(rec: Recording): WireEvent[][] {
  const starts: number[] = [];
  rec.events.forEach((e, i) => {
    if (e.type === 'step' && e.data.status === 'running') starts.push(i);
  });
  if (!starts.length) return [rec.events];
  const out: WireEvent[][] = [];
  starts.forEach((start, k) => out.push(rec.events.slice(start, k + 1 < starts.length ? starts[k + 1] : rec.events.length)));
  return out;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [store, dispatch] = useReducer(reduce, initial);
  const [mode, setModeState] = useState<'live' | 'replay'>('live');
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [replayStep, setReplayStep] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const timers = useRef<number[]>([]);

  const feed = useCallback((ev: WireEvent) => {
    dispatch({ type: 'event', ev });
    listeners.forEach((fn) => fn(ev));
  }, []);

  // Live: one EventSource; the browser reconnects on its own if the Control Centre restarts.
  useEffect(() => {
    if (mode !== 'live') return;
    dispatch({ type: 'reset' });
    fetch('/api/state').then((r) => r.json()).then((data) => feed({ t: Date.now(), type: 'state', data })).catch(() => {});
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (m) => {
        try {
          feed(JSON.parse((m as MessageEvent).data));
        } catch {
          /* ignore a malformed frame */
        }
      });
    }
    return () => es.close();
  }, [mode, feed]);

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  const setMode = useCallback((m: 'live' | 'replay') => {
    clearTimers();
    setReplayPlaying(false);
    if (m === 'replay') {
      fetch('/api/recordings/incident')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no recording'))))
        .then((rec: Recording) => {
          setRecording(rec);
          setReplayStep(0);
          dispatch({ type: 'reset' });
          setConnected(false);
          // Show the system as it was just before the story started.
          const first = rec.events.find((e) => e.type === 'state');
          if (first) feed(first);
          setModeState('replay');
        })
        .catch(() => alert('No recording found. Record one from the Control room (Record the incident).'));
    } else {
      setModeState('live');
    }
  }, [feed]);

  const playSegment = useCallback((events: WireEvent[], done?: () => void) => {
    if (!events.length) {
      done?.();
      return;
    }
    const t0 = events[0].t;
    setReplayPlaying(true);
    events.forEach((ev) => {
      timers.current.push(window.setTimeout(() => feed({ ...ev, t: Date.now() }), ev.t - t0));
    });
    const end = events[events.length - 1].t - t0 + 50;
    timers.current.push(window.setTimeout(() => {
      setReplayPlaying(false);
      done?.();
    }, end));
  }, [feed]);

  const replayNext = useCallback(() => {
    if (!recording || replayPlaying) return;
    const segs = segments(recording);
    const i = replayStep >= segs.length ? 0 : replayStep;
    if (i === 0) {
      dispatch({ type: 'reset' });
      const first = recording.events.find((e) => e.type === 'state');
      if (first) feed(first);
    }
    setReplayStep(i + 1);
    playSegment(segs[i]);
  }, [recording, replayStep, replayPlaying, playSegment, feed]);

  const replayAll = useCallback(() => {
    if (!recording || replayPlaying) return;
    const segs = segments(recording);
    let i = replayStep >= segs.length ? 0 : replayStep;
    if (i === 0) dispatch({ type: 'reset' });
    const step = () => {
      if (i >= segs.length) return;
      const k = i++;
      setReplayStep(k + 1);
      playSegment(segs[k], () => {
        if (i < segs.length) timers.current.push(window.setTimeout(step, 900));
      });
    };
    step();
  }, [recording, replayStep, replayPlaying, playSegment]);

  const replayRestart = useCallback(() => {
    clearTimers();
    setReplayPlaying(false);
    setReplayStep(0);
    dispatch({ type: 'reset' });
    const first = recording?.events.find((e) => e.type === 'state');
    if (first) feed(first);
  }, [recording, feed]);

  const post = useCallback(async (path: string, body?: unknown) => {
    if (mode === 'replay') return { ok: false, message: 'Replay mode: switch to Live to run things.' };
    try {
      const r = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (r.status === 409) {
        const j = await r.json();
        return { ok: false, message: `Busy: ${j.busy}` };
      }
      return { ok: r.ok };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }, [mode]);

  const value = useMemo<Ctx>(() => ({
    store, mode, connected, recording, replayStep, replayPlaying, setMode, replayNext, replayAll, replayRestart, post,
  }), [store, mode, connected, recording, replayStep, replayPlaying, setMode, replayNext, replayAll, replayRestart, post]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useFetch<T>(url: string, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1) };
}
