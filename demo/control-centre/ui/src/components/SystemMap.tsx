import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onEvent, useStore } from '../store';
import { count, money, refLabel, short } from '../format';
import type { Observed, ServiceState, Snapshot } from '../types';

// The live system map. Fixed 1200×262 design coordinates, scaled to the band's width. Events animate from what
// really happens: each dot is a real record on payments.settled (coloured by its real payload), and each dot that
// reaches the ledger is a real consumed offset.

const W = 1200;
const H = 280;
const PUBLISH = [[214, 118], [262, 118], [300, 118]] as const;
const CONSUME = [[640, 118], [700, 118], [914, 118], [962, 84]] as const;
const QUEUE = { x0: 274, x1: 644, rows: [107, 118, 129], gap: 12 };

const COLOURS: Record<string, string> = { v1: '#0BE248', v2: '#FFB16A', both: '#A19FFF', unknown: '#FFFFFF', unreadable: '#FFFFFF' };
const ZERO = '#FF6B6B';

type Pt = readonly [number, number];

interface Particle {
  pts: readonly Pt[];
  lens: number[];
  total: number;
  t0: number;
  dur: number;
  el: SVGCircleElement;
  end?: () => void;
  endColour?: string;
}

function prepare(pts: readonly Pt[]) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { lens, total: lens[lens.length - 1] };
}

function at(p: Particle, f: number): Pt {
  const d = f * p.total;
  let i = 1;
  while (i < p.lens.length - 1 && p.lens[i] < d) i++;
  const seg = p.lens[i] - p.lens[i - 1] || 1;
  const k = Math.min(1, Math.max(0, (d - p.lens[i - 1]) / seg));
  return [p.pts[i - 1][0] + (p.pts[i][0] - p.pts[i - 1][0]) * k, p.pts[i - 1][1] + (p.pts[i][1] - p.pts[i - 1][1]) * k];
}

/** Would this ledger version book this event at £0.00? (What the real code does, per version.) */
function booksZero(ledgerRef: string | null | undefined, format: string): boolean {
  if (!ledgerRef) return false;
  if (ledgerRef === 'main') return format === 'v2';            // v1 reads double amount: missing → 0.0
  if (ledgerRef.startsWith('pr-482')) return format === 'v1';  // v2 reads long amountMinor: missing → 0
  return false;                                                 // the split reads whichever is present
}

function useScale(ref: React.RefObject<HTMLDivElement>) {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1.3, el.clientWidth / W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return scale;
}

export default function SystemMap({ children }: { children?: React.ReactNode }) {
  const { store, mode } = useStore();
  const s = store.state;
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const scale = useScale(wrap);
  const particles = useRef<Particle[]>([]);
  const spawnQueue = useRef<(() => void)[]>([]);
  const observedRef = useRef<Observed[]>([]);
  const snapRef = useRef<Snapshot | null>(null);
  const consumedUpTo = useRef<number | null>(null);
  const lastPop = useRef(0);

  observedRef.current = store.observed;
  snapRef.current = s;

  // One animation loop for every dot.
  useEffect(() => {
    let raf = 0;
    let lastSpawn = 0;
    const tick = (now: number) => {
      if (spawnQueue.current.length && now - lastSpawn > 28) {
        spawnQueue.current.shift()!();
        lastSpawn = now;
      }
      particles.current = particles.current.filter((p) => {
        const f = Math.min(1, (now - p.t0) / p.dur);
        const [x, y] = at(p, f);
        p.el.setAttribute('cx', x.toFixed(1));
        p.el.setAttribute('cy', y.toFixed(1));
        if (p.endColour && f > 0.82) p.el.setAttribute('fill', p.endColour);
        if (f >= 1) {
          p.el.remove();
          p.end?.();
          return false;
        }
        return true;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const spawn = (pts: readonly Pt[], colour: string, dur: number, endColour?: string, end?: () => void) => {
    spawnQueue.current.push(() => {
      const g = layer.current;
      if (!g || particles.current.length > 120) return;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      el.setAttribute('r', '5.5');
      el.setAttribute('fill', colour);
      el.setAttribute('stroke', 'rgba(0,0,0,.35)');
      el.setAttribute('stroke-width', '1');
      g.appendChild(el);
      const { lens, total } = prepare(pts);
      particles.current.push({ pts, lens, total, t0: performance.now(), dur, el, end, endColour });
    });
  };

  const pop = () => {
    const now = performance.now();
    if (now - lastPop.current < 160 || !stage.current) return;
    lastPop.current = now;
    const d = document.createElement('div');
    d.className = 'zero-pop';
    d.textContent = '£0.00';
    d.style.left = `${905 + Math.random() * 40}px`;
    d.style.top = `${128 + Math.random() * 16}px`;
    stage.current.appendChild(d);
    window.setTimeout(() => d.remove(), 1700);
  };

  // A new record on the topic: a dot from settlement-service into the pipe.
  useEffect(() => onEvent((ev) => {
    if (ev.type === 'observed') spawn(PUBLISH, COLOURS[ev.data.format] ?? '#fff', 420);
  }), []);

  // ledger-service consumed offsets [a, b): dots from the pipe into the ledger and the table.
  useEffect(() => {
    if (!s?.kafka) return;
    const upTo = s.kafka.published - s.kafka.lag;
    const prev = consumedUpTo.current;
    consumedUpTo.current = upTo;
    if (prev == null || upTo <= prev || upTo - prev > 200) return;
    const ledgerRef = s.services['ledger-service']?.ref;
    const byOffset = new Map(observedRef.current.map((o) => [o.offset, o.format]));
    for (let off = prev; off < upTo && off < prev + 60; off++) {
      const format = byOffset.get(off) ?? 'unknown';
      const zero = booksZero(ledgerRef, format);
      spawn(CONSUME, COLOURS[format] ?? '#fff', 900, zero ? ZERO : undefined, zero ? pop : undefined);
    }
  }, [s?.kafka?.published, s?.kafka?.lag]); // eslint-disable-line react-hooks/exhaustive-deps

  const settlement = s?.services['settlement-service'];
  const ledger = s?.services['ledger-service'];
  const recon = s?.services['reconciliation-batch'];
  const lag = s?.kafka?.lag ?? 0;
  const published = s?.kafka?.published ?? 0;
  const queue = queueColours(store.observed, published, lag, settlement?.ref);
  const cols = s?.ledger?.columns ?? [];
  const zero = s?.ledger?.zero ?? 0;
  const infraDown = s && s.infra.status !== 'UP';

  return (
    <section className="map-band" aria-label="Live system map">
      <div className="map-head">
        <div className="row" style={{ gap: 14 }}>
          <h2>Northwind Payments, live</h2>
          <span className="sub">{mode === 'replay' ? 'recorded run, played back' : 'real services · real Kafka · real Postgres · on this laptop'}</span>
        </div>
        <div className="legend">
          <span><i style={{ background: COLOURS.v1 }} />v1 event: <code>amount</code> in £</span>
          <span><i style={{ background: COLOURS.v2 }} />v2 event: <code>amountMinor</code> in pence</span>
          <span><i style={{ background: COLOURS.both }} />both (the split)</span>
          <span><i style={{ background: ZERO }} />booked at £0.00</span>
        </div>
      </div>
      <div className="map-scale" ref={wrap} style={{ height: H * scale }}>
        <div className="map-stage" ref={stage} style={{ transform: `scale(${scale})` }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#5E9C83" />
              </marker>
            </defs>
            <line x1="214" y1="118" x2="258" y2="118" stroke="#5E9C83" strokeWidth="2" markerEnd="url(#arrow)" />
            <rect x="262" y="96" width="392" height="44" rx="22" fill="#013324" stroke={lag > 0 ? '#FFB16A' : '#2E8A66'} strokeWidth="2" />
            <line x1="654" y1="118" x2="696" y2="118" stroke="#5E9C83" strokeWidth="2" markerEnd="url(#arrow)" />
            <path d="M914 116 C 936 116, 938 86, 958 86" fill="none" stroke="#5E9C83" strokeWidth="2" markerEnd="url(#arrow)" />
            <path d="M760 180 C 760 200, 700 192, 658 190" fill="none" stroke="#5E9C83" strokeWidth="1.5" strokeDasharray="4 4" markerEnd="url(#arrow)" />
            <line x1="1081" y1="188" x2="1081" y2="166" stroke={recon?.ref && s?.recon?.error ? ZERO : '#5E9C83'} strokeWidth="2" markerEnd="url(#arrow)" />
            {queue.slice(0, 90).map((c, i) => {
              const col = Math.floor(i / 3);
              const row = i % 3;
              return <circle key={i} cx={QUEUE.x1 - col * QUEUE.gap} cy={QUEUE.rows[row]} r="4.6" fill={c} opacity={0.95} />;
            })}
            <g ref={layer} />
          </svg>

          <ServiceNode name="settlement-service" svc={settlement} left={0} top={52} note="POST /settlements" />
          <ServiceNode name="ledger-service" svc={ledger} left={700} top={52} note="consumes, books" />

          <div className="pipe-label" style={{ left: 266, top: 66 }}>
            <code>payments.settled</code> Kafka topic
            {lag > 0 && <span className="backlog-badge">backlog {count(lag)}</span>}
            {queue.length > 90 && <span className="backlog-badge">+{queue.length - 90}</span>}
          </div>
          <div className="edge-label" style={{ left: 266, top: 146 }}>{count(published)} events published</div>
          <div className="dlt" style={{ left: 418, top: 170 }}>
            <code>payments.settled.DLT</code> <b>{count(s?.kafka?.dlt ?? 0)}</b> records
          </div>

          <div className={`node table${zero > 0 ? ' alarm' : ''}`} style={{ left: 962, top: 0, width: 238, height: 166 }}>
            <div className="name"><span>ledger_entries</span><span className="meta">Postgres 16</span></div>
            <div className="stack" style={{ gap: 3 }}>
              {cols.length === 0 && <div className="col-line">no table yet</div>}
              {cols.includes('amount') && <div className="col-line"><span>amount</span><span>numeric(12,2)</span></div>}
              {cols.includes('amount_minor') && !cols.includes('amount') && <div className="col-line gone"><span>amount</span><span>renamed</span></div>}
              {cols.includes('amount_minor') && <div className="col-line changed"><span>amount_minor</span><span>bigint</span></div>}
            </div>
            <div className="table-stats">
              <span><b>{count(s?.ledger?.rows ?? 0)}</b> rows</span>
              <span><b>{money(s?.ledger?.booked ?? 0)}</b></span>
              <span className={zero > 0 ? 'bad' : ''}><b>{count(zero)}</b> at £0.00</span>
            </div>
          </div>
          <div className="edge-label" style={{ left: 1088, top: 168 }}>reads directly</div>

          <ReconNode svc={recon} snap={s} />

          {infraDown && (
            <div className="infra-down">
              <div className="stack" style={{ alignItems: 'center' }}>
                <h2>{s?.infra.status === 'STARTING' ? 'Starting Postgres and Kafka…' : 'Postgres or Kafka did not start'}</h2>
                {s?.infra.failure && <p className="mono small">{s.infra.failure}</p>}
                {s?.infra.status === 'FAILED' && <p>Replay mode still works: switch to Replay at the top right.</p>}
              </div>
            </div>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

function queueColours(observed: Observed[], published: number, lag: number, settlementRef?: string | null): string[] {
  if (lag <= 0) return [];
  const from = published - lag;
  const byOffset = new Map(observed.map((o) => [o.offset, o.format]));
  const fallback = settlementRef?.startsWith('pr-482') ? COLOURS.v2 : settlementRef === 'main' ? COLOURS.v1 : COLOURS.both;
  const out: string[] = [];
  for (let off = from; off < published; off++) out.push(COLOURS[byOffset.get(off) ?? ''] ?? fallback);
  return out;
}

function statusOf(svc?: ServiceState): 'up' | 'starting' | 'failed' | 'off' {
  if (!svc || !svc.ref) return 'off';
  if (svc.status === 'FAILED') return 'failed';
  if (svc.health === 'UP') return 'up';
  if (svc.status === 'STARTING') return 'starting';
  return 'off';
}

function ServiceNode({ name, svc, left, top, note }: { name: string; svc?: ServiceState; left: number; top: number; note: string }) {
  const st = statusOf(svc);
  const label = refLabel(svc?.ref);
  const statusText = { up: 'UP', starting: 'starting…', failed: 'failed to start', off: svc?.ref ? 'stopped' : 'not running' }[st];
  return (
    <div className={`node ${st === 'failed' ? 'failed' : st === 'starting' ? 'starting' : ''}`} style={{ left, top, width: 214, minHeight: 128 }}>
      <div className="name"><span>{name}</span><span className={`dot dot-${st}`} /></div>
      <div><span className={`chip chip-${label.kind}`}>{label.text}</span></div>
      <div className="meta"><span>{statusText}</span><span>·</span><span>:{svc?.port ?? '–'}</span><span>·</span><span>{note}</span></div>
      {st === 'failed' && svc?.failure && <div className="why" title={svc.failure}>{short(svc.failure.replace(/^.*?Schema-validation/, 'Schema-validation'), 110)}</div>}
    </div>
  );
}

function ReconNode({ svc, snap }: { svc?: ServiceState; snap: Snapshot | null }) {
  const label = refLabel(svc?.ref);
  const r = snap?.recon;
  return (
    <div className={`node ${r?.error ? 'failed' : ''}`} style={{ left: 962, top: 188, width: 238, minHeight: 72, padding: '8px 12px', gap: 4 }}>
      <div className="name" style={{ fontSize: 14 }}><span>reconciliation-batch</span><span className={`chip chip-${label.kind}`} style={{ fontSize: 11.5 }}>{label.text}</span></div>
      {!r && <div className="meta">finance's job · runs on demand</div>}
      {r && !r.error && <div className="meta">last run: <b style={{ color: '#fff' }}>{money(r.total)}</b> · {count(r.entries)} rows</div>}
      {r?.error && <div className="why" style={{ maxHeight: 32 }}>{short(r.error, 70)}</div>}
    </div>
  );
}
