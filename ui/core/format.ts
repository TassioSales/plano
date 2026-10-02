const nf = new Intl.NumberFormat("pt-BR");
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/** 0.137 → "0,14 ms"; 1905 → "1,9 s". */
export function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${nf1.format(ms / 60_000)} min`;
  if (ms >= 1000) return `${nf2.format(ms / 1000)} s`;
  if (ms >= 10) return `${nf.format(Math.round(ms))} ms`;
  return `${nf2.format(ms)} ms`;
}

export const fmtCount = (n: number) => nf.format(Math.round(n));

/** Large counts, short: 1.000.000 → "1 mi". */
export function fmtShort(n: number): string {
  if (n >= 1e9) return `${nf1.format(n / 1e9)} bi`;
  if (n >= 1e6) return `${nf1.format(n / 1e6)} mi`;
  if (n >= 1e4) return `${nf.format(Math.round(n / 1e3))} mil`;
  return nf.format(Math.round(n));
}

export function fmtPct(fraction: number): string {
  const p = fraction * 100;
  if (p >= 99.95 && p < 100) return "99,9%";
  return `${p >= 10 || p === 0 ? nf.format(Math.round(p)) : nf1.format(p)}%`;
}

export const fmtFactor = (f: number) => `${f >= 10 ? nf.format(Math.round(f)) : nf1.format(f)}×`;

/** Kilobytes → "24 MB". */
export function fmtSize(kb: number): string {
  if (kb >= 1024 * 1024) return `${nf1.format(kb / 1024 / 1024)} GB`;
  if (kb >= 1024) return `${nf.format(Math.round(kb / 1024))} MB`;
  return `${nf.format(Math.round(kb))} kB`;
}
