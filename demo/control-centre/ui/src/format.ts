const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 });

export function money(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? '–' : gbp.format(v);
}

export function count(v: number | null | undefined): string {
  return v == null ? '–' : v.toLocaleString('en-GB');
}

/** How a git ref reads on screen. */
export function refLabel(ref: string | null | undefined): { text: string; kind: 'v1' | 'v2' | 'split' | 'none' } {
  if (!ref) return { text: 'not deployed', kind: 'none' };
  if (ref === 'main') return { text: 'v1 · main', kind: 'v1' };
  if (ref.startsWith('pr-482')) return { text: 'v2 · PR #482', kind: 'v2' };
  const m = /^split\/(\d)-(\w+)/.exec(ref);
  if (m) return { text: `split ${m[1]} · ${m[2]}`, kind: 'split' };
  return { text: ref, kind: 'split' };
}

export function short(text: string | null | undefined, n: number): string {
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

export function clockTime(t: number): string {
  return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
