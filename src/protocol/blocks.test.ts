import { describe, expect, it } from 'vitest';
import { decodeLiveBlock, decodeSavedPreset } from './blocks';
import { hex } from './frame';
import { identifyRequest, patchListRequest } from './requests';
import { crc16 } from './crc';

describe('decodeLiveBlock', () => {
  it('AMP 0x93: u16 big-endian enabled, type, gain..mst', () => {
    // enabled=1, type=7 (J800), gain=60, bass=50, mid=40, treble=55, pres=45, mst=70
    const p = Uint8Array.from([0, 1, 0, 7, 0, 60, 0, 50, 0, 40, 0, 55, 0, 45, 0, 70]);
    const b = decodeLiveBlock(0x93, p)!;
    expect(b.enabled).toBe(true);
    expect(b.typeName).toBe('J800');
    expect(b.values.map((v) => v.value)).toEqual([60, 50, 40, 55, 45, 70]);
  });
  it('tipo fora da lista vira "tipo N"', () => {
    const b = decodeLiveBlock(0x99, Uint8Array.from([0, 0, 0, 3, 0, 1, 0, 2, 0, 3, 0, 4]))!;
    expect(b.enabled).toBe(false);
    expect(b.typeName).toBe('tipo 3');
  });
  it('ignora código que não é bloco', () => {
    expect(decodeLiveBlock(0xa6, new Uint8Array(12))).toBeNull();
  });
});

describe('decodeSavedPreset', () => {
  it('lê nome e blocos nos offsets do .mo (preset começa em 0x200 do arquivo)', () => {
    const p = new Uint8Array(512);
    p.set(new TextEncoder().encode('LEAD SOLO'), 12);
    // AMP no offset 44 (arquivo 556 = mooer.php $array[557]): type 18 (MARK V CL), on, gain 77
    p.set([18, 1, 77, 50, 50, 50, 50, 60], 44);
    // DS no offset 36: type 2 (808), off
    p.set([2, 0, 40, 50, 30], 36);
    p[350] = 0x2c; p[351] = 0x01; // delay time 300
    const s = decodeSavedPreset(p);
    expect(s.name).toBe('LEAD SOLO');
    const amp = s.blocks.find((b) => b.key === 'amp')!;
    expect(amp.typeName).toBe('MARK V CL');
    expect(amp.enabled).toBe(true);
    expect(amp.values[0]).toEqual({ name: 'gain', value: 77 });
    const ds = s.blocks.find((b) => b.key === 'ds')!;
    expect(ds.typeName).toBe('808');
    expect(ds.enabled).toBe(false);
    expect(s.delayTime).toBe(300);
  });
});

describe('pedidos de leitura', () => {
  it('identify = AA 55 03 00 84 00 00 + CRC', () => {
    const f = identifyRequest();
    expect(hex(f.subarray(0, 7))).toBe('AA 55 03 00 84 00 00');
    expect((f[7] << 8) | f[8]).toBe(crc16(f.subarray(2, 7)));
  });
  it('lista de presets = AA 55 08 00 E0 00×7 + CRC', () => {
    expect(hex(patchListRequest().subarray(0, 12))).toBe('AA 55 08 00 E0 00 00 00 00 00 00 00');
  });
});
