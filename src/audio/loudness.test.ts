import { describe, expect, it } from 'vitest';
import { dbToVolume, energyToLufs, estimateK, integratedLufs, lufsToEnergy, suggest, volumeToDb, type Measurement } from './loudness';

describe('loudness', () => {
  it('energia ↔ LUFS', () => {
    expect(energyToLufs(0.5)).toBeCloseTo(-3.70, 1); // -0.691 + 10log10(0.5)
    expect(energyToLufs(lufsToEnergy(-23))).toBeCloseTo(-23, 6);
  });
  it('gate: silêncio não puxa a média para baixo', () => {
    const loud = lufsToEnergy(-20);
    const blocks = [...Array(40).fill(loud), ...Array(40).fill(1e-12)];
    expect(Math.abs(integratedLufs(blocks) + 20)).toBeLessThan(0.3); // janelas de transição contam (BS.1770)
  });
  it('tudo em silêncio → -Infinity', () => {
    expect(integratedLufs(Array(20).fill(0))).toBe(-Infinity);
  });
});

describe('Preset Volume', () => {
  it('modelo linear em amplitude: 50 = -6 dB', () => {
    expect(volumeToDb(50, 1)).toBeCloseTo(-6.02, 2);
    expect(dbToVolume(-6.0206, 1)).toBeCloseTo(50, 2);
  });
  const ms: Measurement[] = [
    { idx: 0, name: 'A', lufs: -20, volume: 100, solo: false },
    { idx: 1, name: 'B', lufs: -14, volume: 100, solo: false },
    { idx: 2, name: 'C', lufs: -17, volume: 50, solo: false },
    { idx: 3, name: 'SOLO', lufs: -18, volume: 80, solo: true },
  ];
  it('mediana: base = mediana, solo recebe +dB', () => {
    const r = suggest(ms, { mode: 'mediana', soloDb: 2.5, k: 1 });
    // bases: -20, -14, -17, -20.5 → mediana -18.5
    expect(r.base).toBeCloseTo(-18.5, 6);
    const b = r.items.find((i) => i.idx === 1)!;
    expect(b.suggested).toBe(Math.round(100 * Math.pow(10, -4.5 / 20)));
    const a = r.items.find((i) => i.idx === 0)!;
    expect(a.suggested).toBe(100);
    expect(a.clamped).toBe(true);
    expect(a.residualDb).toBeCloseTo(1.5, 1);
    const s = r.items.find((i) => i.idx === 3)!;
    expect(s.target).toBeCloseTo(-16, 6);
  });
  it('sem passar de 100: ninguém fica limitado', () => {
    const r = suggest(ms, { mode: 'sem-passar-100', soloDb: 2.5, k: 1 });
    for (const i of r.items) {
      expect(i.suggested).toBeLessThanOrEqual(100);
      expect(Math.abs(i.residualDb)).toBeLessThan(0.2);
    }
    expect(r.items.find((i) => i.idx === 0)!.suggested).toBe(100);
  });
  it('referência', () => {
    const r = suggest(ms, { mode: 'referencia', soloDb: 3, k: 1, refIdx: 2 });
    expect(r.base).toBe(-17);
    expect(r.items.find((i) => i.idx === 2)!.suggested).toBe(50);
  });
  it('estima k pela remedição', () => {
    expect(estimateK(100, -14, 50, -20.02)).toBeCloseTo(1, 2);
    expect(estimateK(100, -14, 50, -14)).toBeCloseTo(0, 2); // volume não afeta a captação
    expect(estimateK(100, -14, 98, -14.2)).toBeNull();
  });
});
