/**
 * Loudness (aproximação da ITU-R BS.1770 / EBU R128) e cálculo das sugestões de Preset Volume.
 * Puro, sem Web Audio: recebe blocos de energia (média dos quadrados) de 100 ms já filtrados (K-weighting).
 */

/** Energia (soma dos canais da média dos quadrados) → LUFS. */
export function energyToLufs(e: number): number {
  return e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity;
}

export function lufsToEnergy(l: number): number {
  return Math.pow(10, (l + 0.691) / 10);
}

/** Janelas de 400 ms com 75% de sobreposição a partir de blocos de 100 ms. */
export function windows400(blocks: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 4 <= blocks.length; i++) out.push((blocks[i] + blocks[i + 1] + blocks[i + 2] + blocks[i + 3]) / 4);
  return out;
}

/** Loudness integrada com gate absoluto (-70 LUFS) e relativo (-10 LU). */
export function integratedLufs(blocks: number[]): number {
  const w = windows400(blocks).filter((e) => energyToLufs(e) > -70);
  if (!w.length) return -Infinity;
  const rel = energyToLufs(w.reduce((a, b) => a + b, 0) / w.length) - 10;
  const g = w.filter((e) => energyToLufs(e) > rel);
  if (!g.length) return -Infinity;
  return energyToLufs(g.reduce((a, b) => a + b, 0) / g.length);
}

/** Média dos últimos n blocos (momentânea: 4, curta: 30). */
export function recentLufs(blocks: number[], n: number): number {
  if (blocks.length < 1) return -Infinity;
  const s = blocks.slice(-n);
  return energyToLufs(s.reduce((a, b) => a + b, 0) / s.length);
}

// ---------- Preset Volume ----------

/**
 * Modelo do Preset Volume (HIPÓTESE, refinada por medição): ganho em dB = k · 20·log10(V/100).
 * k = 1 significa volume linear em amplitude. O app mede o k real comparando antes/depois.
 */
export function volumeToDb(v: number, k: number): number {
  return k * 20 * Math.log10(Math.max(v, 1) / 100);
}

export function dbToVolume(db: number, k: number): number {
  return 100 * Math.pow(10, db / (20 * k));
}

export interface Measurement {
  idx: number;
  name: string;
  lufs: number;
  /** Preset Volume no momento da medição. */
  volume: number;
  solo: boolean;
}

export type TargetMode = 'mediana' | 'sem-passar-100' | 'referencia';

export interface Suggestion {
  idx: number;
  name: string;
  measured: number;
  current: number;
  /** Loudness desejada para este preset (LUFS). */
  target: number;
  suggested: number;
  /** Diferença prevista em dB depois de aplicar (0 = exato; ≠0 quando bateu no limite). */
  residualDb: number;
  clamped: boolean;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Calcula o volume sugerido de cada preset medido. */
export function suggest(ms: Measurement[], opts: { mode: TargetMode; soloDb: number; k: number; refIdx?: number }): { base: number; items: Suggestion[] } {
  const valid = ms.filter((m) => Number.isFinite(m.lufs));
  if (!valid.length) return { base: NaN, items: [] };
  const off = (m: Measurement) => (m.solo ? opts.soloDb : 0);
  // "base" = loudness de um preset normal (sem o acréscimo de solo)
  let base: number;
  if (opts.mode === 'referencia') {
    const r = valid.find((m) => m.idx === opts.refIdx) ?? valid[0];
    base = r.lufs - off(r);
  } else if (opts.mode === 'sem-passar-100') {
    // o maior alvo que todos conseguem atingir sem passar de volume 100
    base = Math.min(...valid.map((m) => m.lufs + (volumeToDb(100, opts.k) - volumeToDb(m.volume, opts.k)) - off(m)));
  } else {
    base = median(valid.map((m) => m.lufs - off(m)));
  }
  const items = valid.map((m) => {
    const target = base + off(m);
    const wantDb = volumeToDb(m.volume, opts.k) + (target - m.lufs);
    const raw = dbToVolume(wantDb, opts.k);
    const suggested = Math.max(1, Math.min(100, Math.round(raw)));
    const residualDb = target - (m.lufs + volumeToDb(suggested, opts.k) - volumeToDb(m.volume, opts.k));
    return { idx: m.idx, name: m.name, measured: m.lufs, current: m.volume, target, suggested, residualDb, clamped: raw > 100.5 || raw < 0.5 };
  });
  return { base, items };
}

/**
 * Estima k a partir de uma remedição: mesmo preset, volume v1→v2, loudness l1→l2.
 * Retorna null se a mudança de volume for pequena demais para concluir algo.
 */
export function estimateK(v1: number, l1: number, v2: number, l2: number): number | null {
  const d = 20 * Math.log10(Math.max(v2, 1) / Math.max(v1, 1));
  if (Math.abs(d) < 1.5 || !Number.isFinite(l1) || !Number.isFinite(l2)) return null;
  return (l2 - l1) / d;
}
