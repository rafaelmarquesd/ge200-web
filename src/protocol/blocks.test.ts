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

describe('preset real (dump do aparelho, preset 28 "DEE CORE RIFF")', () => {
  const h = '05 01 02 03 06 07 08 09 04 00 64 01 44 45 45 20 43 4f 52 45 20 52 49 46 46 00 00 00 07 00 37 4a 14 4d 00 00 03 00 51 32 00 00 00 00 01 01 46 32 29 30 44 5a 01 01 00 14 19 01 00 00 02 00 30 63 47 00 00 00 01 00 0c 0c 0d 0d 0c 0c 01 00 64 32 32 32 00 00 03 01 14 0a 00 01 00 01 05 01 00 14 14 1e 00 00';
  const p = new Uint8Array(512);
  p.set(h.split(' ').map((x) => parseInt(x, 16)));
  p[350] = 0x8c;
  const s = decodeSavedPreset(p);
  it('nome, volume provável e delay time', () => {
    expect(s.name).toBe('DEE CORE RIFF');
    expect(s.volume).toBe(100);
    expect(s.delayTime).toBe(140);
  });
  it('bate com os frames ao vivo capturados no mesmo dump', () => {
    const live = (hexs: string) => Uint8Array.from(hexs.split(' ').slice(1).map((x) => parseInt(x, 16)));
    const pairs: [number, string][] = [
      [0x90, '90 00 00 00 07 00 37 00 4A 00 14 00 4D'],
      [0x93, '93 00 01 00 01 00 46 00 32 00 29 00 30 00 44 00 5A'],
      [0x94, '94 00 01 00 01 00 00 00 14 00 19 00 01'],
      [0x95, '95 00 00 00 02 00 30 00 63 00 47'],
      [0x99, '99 00 01 00 05 00 00 00 14 00 14 00 1E'],
    ];
    for (const [cmd, hx] of pairs) {
      const lv = decodeLiveBlock(cmd, live(hx))!;
      const sv = s.blocks.find((b) => b.key === lv.key)!;
      expect(sv.enabled).toBe(lv.enabled);
      expect(sv.type).toBe(lv.type);
      for (const v of sv.values) expect(lv.values.find((x) => x.name === v.name)?.value).toBe(v.value);
    }
  });
});

describe('comandos de escrita', async () => {
  const { presetChange } = await import('./commands');
  it('A6 idx', () => {
    expect(hex(presetChange(28).frame.subarray(0, 6))).toBe('AA 55 02 00 A6 1C');
    expect(presetChange(28).risk).toBe('volatil');
  });
  it('recusa índice fora da faixa', () => {
    expect(() => presetChange(200)).toThrow();
    expect(() => presetChange(-1)).toThrow();
  });
});
