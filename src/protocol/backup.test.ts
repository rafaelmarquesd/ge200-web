import { describe, expect, it } from 'vitest';
import { diffPresets, makeBackup, offsetName, parseBackup, toMo, hexToBytes } from './backup';
import { loadPresetToBuffer, menuSwitch, setBlock } from './commands';
import { hex } from './frame';

const preset = (vol: number) => {
  const p = new Uint8Array(512);
  p[10] = vol;
  p.set(new TextEncoder().encode('TESTE'), 12);
  return p;
};

describe('backup', () => {
  const presets = Array.from({ length: 200 }, (_, i) => ({ name: `P${i}`, volume: 100, raw: preset(100) }));
  it('ida e volta pelo JSON', () => {
    const b = makeBackup({ appVersion: 't', device: null, activeIdx: 3, presets, extras: { A1: '09 01' } });
    const r = parseBackup(JSON.stringify(b));
    expect(r.presets).toHaveLength(200);
    expect(hexToBytes(r.presets[5].hex)).toEqual(preset(100));
  });
  it('recusa arquivo que não é backup', () => {
    expect(() => parseBackup('{"a":1}')).toThrow(/não é um backup/);
    expect(() => parseBackup('xx')).toThrow(/JSON/);
  });
  it('exige os 200 presets', () => {
    expect(() => makeBackup({ appVersion: 't', device: null, activeIdx: 0, presets: presets.slice(1), extras: {} })).toThrow();
  });
  it('.mo tem 2048 bytes com o preset em 0x200', () => {
    const mo = toMo(preset(77));
    expect(mo.length).toBe(2048);
    expect(mo[0x200 + 10]).toBe(77);
  });
  it('diff aponta a mudança de volume', () => {
    const d = diffPresets([preset(100), preset(50)], [preset(100), preset(65)], ['A', 'B']);
    expect(d).toEqual([{ index: 1, name: 'B', changes: [{ offset: 10, before: 50, after: 65 }] }]);
    expect(offsetName(10)).toBe('VOLUME do preset');
    expect(offsetName(46)).toBe('AMP gain');
    expect(offsetName(86)).toBe('DELAY level');
    expect(offsetName(89)).toBe('DELAY subd');
    expect(offsetName(88)).toBe('DELAY byte 4');
    expect(offsetName(352)).toBe('DELAY p5');
  });
});

describe('comandos de escrita da Fase 4', () => {
  it('menu', () => {
    expect(hex(menuSwitch(3).frame.subarray(0, 6))).toBe('AA 55 02 00 82 03');
  });
  it('setBlock reproduz o formato do MooerManager (AMP)', () => {
    const raw = Uint8Array.from([0, 1, 0, 0x21, 0, 45, 0, 40, 0, 60, 0, 50, 0, 45, 0, 50]);
    const f = setBlock(0x93, raw, 'AMP').frame;
    expect(hex(f.subarray(0, 5))).toBe('AA 55 11 00 93');
    expect(f.length).toBe(4 + 17 + 2);
  });
  it('setBlock recusa tamanho errado, tipo 0, MOD perigoso e DELAY/REVERB', () => {
    expect(() => setBlock(0x93, new Uint8Array(15), 'x')).toThrow();
    expect(() => setBlock(0x91, new Uint8Array(10), 'x')).toThrow(/tipo/);
    const mod = new Uint8Array(14);
    mod[3] = 22;
    expect(() => setBlock(0x97, mod, 'x')).toThrow(/travaria/);
    const dly = new Uint8Array(16);
    dly[3] = 1;
    expect(() => setBlock(0x98, dly, 'x')).toThrow(/não pode/);
  });
  it('83 + 512 bytes, volume validado', () => {
    const f = loadPresetToBuffer(preset(80), 'vol').frame;
    expect(hex(f.subarray(0, 5))).toBe('AA 55 01 02 83');
    expect(f.length).toBe(4 + 513 + 2);
    expect(() => loadPresetToBuffer(preset(101), 'x')).toThrow();
  });
});
