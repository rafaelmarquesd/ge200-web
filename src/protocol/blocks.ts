/**
 * Decodificação dos blocos de efeito.
 *
 * Dois formatos (veja PROTOCOL.md §4 e §6):
 *  - "ao vivo" (frames 0x90..0x99): campos u16 big-endian, ordem enabled, type, params...
 *  - "salvo" (preset de 512 bytes, frame 0xA5 / arquivo .mo): 8 bytes por bloco, u8, ordem type, enabled, params...
 *
 * Nomes de campos e listas de tipos portados do MooerManager (GPL-2.0)
 * e do mooerMoConvert. Puro, sem I/O.
 */

import { AMP_MODEL_NAMES, CAB_MODEL_NAMES } from './constants';
import { ascii } from './frame';

export interface BlockDef {
  key: string;
  label: string;
  /** Código do frame ao vivo. */
  cmd: number;
  /** Nomes dos campos u16 após enabled/type no frame ao vivo. */
  liveFields: string[];
  /** Nomes dos bytes 2..7 do bloco no preset salvo (null = desconhecido). */
  savedFields: (string | null)[];
  types?: string[];
}

export const FX_TYPES = ['Cry Wah', '535 Wah', 'Auto Wah', 'Talk Wah ah', 'Talk Wah oh', 'Touch Wah', 'Yellow Comp', 'Blue Comp'];
export const DS_TYPES = ['Tube Drive', '808', 'Pure Boost', 'Flex Boost', 'D Drive', 'BlackRat', 'Grey Faze', 'Muffy', 'Metal Zone',
  'Metal Master', 'Obsessive Distortion', 'Jimmy OD', 'Full Drive', 'Shred', 'BeeBee Pre', 'BeeBee +', 'Riet', 'Tight DS', 'Full DS', 'Gold Clone'];
export const NS_TYPES = ['Noise Killer', 'Intel Reducer', 'Noise Gate'];
export const EQ_TYPES = ['MOOER G', 'MOOER HM', 'MOOER G-6', 'Custom EQ'];
export const MOD_TYPES = ['Phaser', 'Step Phaser', 'Fat Phaser', 'Flanger', 'Jet-Flanger', 'Tremolo', 'Stutter', 'Vibrato', 'Poly Pitch',
  'Detune', 'Rotary Speaker', 'Ana-Chorus', 'Tri-Chorus', 'Ring Modulator', 'Q-Filter', 'High Pass', 'Low Pass', 'Slow Gear', 'Lo-Fi', 'Mono Pitch'];

/** Ordem igual à do preset salvo (offset 28 + 8*i). */
export const BLOCKS: BlockDef[] = [
  { key: 'fx', label: 'FX/COMP', cmd: 0x90, liveFields: ['p1', 'p2', 'p3', 'level'],
    // significado de p1..p3 depende do tipo (wah: q/position/peak; comp: attack/thresh/ratio)
    savedFields: ['p1', 'p2', 'p3', 'level', null, null], types: FX_TYPES },
  { key: 'ds', label: 'DS/OD', cmd: 0x91, liveFields: ['volume', 'tone', 'gain'],
    savedFields: ['volume', 'tone', 'gain', null, null, null], types: DS_TYPES },
  { key: 'amp', label: 'AMP', cmd: 0x93, liveFields: ['gain', 'bass', 'mid', 'treble', 'pres', 'mst'],
    savedFields: ['gain', 'bass', 'mid', 'treble', 'pres', 'mst'], types: AMP_MODEL_NAMES },
  { key: 'cab', label: 'CAB', cmd: 0x94, liveFields: ['mic', 'center', 'distance', 'tube'],
    savedFields: ['mic', 'center', 'distance', 'tube', null, null], types: CAB_MODEL_NAMES },
  { key: 'ns', label: 'NS GATE', cmd: 0x95, liveFields: ['attack', 'release', 'thresh'],
    savedFields: ['attack', 'release', 'thresh', null, null, null], types: NS_TYPES },
  { key: 'eq', label: 'EQ', cmd: 0x96, liveFields: ['band1', 'band2', 'band3', 'band4', 'band5', 'band6'],
    savedFields: ['band1', 'band2', 'band3', 'band4', 'band5', 'band6'], types: EQ_TYPES },
  { key: 'mod', label: 'MOD', cmd: 0x97, liveFields: ['rate', 'level', 'depth', 'p4', 'p5'],
    savedFields: ['rate', 'level', 'depth', 'p4', null, null], types: MOD_TYPES },
  { key: 'dly', label: 'DELAY', cmd: 0x98, liveFields: ['level', 'feedback', 'time', 'subd', 'p5', 'p6'],
    savedFields: ['level', 'feedback', null, null, null, 'subd'] },
  { key: 'rvb', label: 'REVERB', cmd: 0x99, liveFields: ['preDelay', 'level', 'decay', 'tone'],
    savedFields: ['preDelay', 'level', 'decay', 'tone', null, null] },
];

export const BLOCK_BY_CMD = new Map(BLOCKS.map((b) => [b.cmd, b]));

export interface BlockState {
  key: string;
  label: string;
  enabled: boolean;
  type: number;
  typeName: string;
  values: { name: string; value: number }[];
  /** Bytes do frame ao vivo (após o CMD), para reenviar preservando campos desconhecidos. */
  raw?: Uint8Array;
}

export function typeName(def: BlockDef, type: number): string {
  const n = def.types?.[type - 1];
  return n ? n : `tipo ${type}`;
}

/** Decodifica um frame ao vivo 0x90..0x99 (params = bytes após o CMD, sem CRC). */
export function decodeLiveBlock(cmd: number, params: Uint8Array): BlockState | null {
  const def = BLOCK_BY_CMD.get(cmd);
  if (!def || params.length < 4) return null;
  const u16 = (i: number) => (params[i] << 8) | params[i + 1];
  const enabled = u16(0) !== 0;
  const type = u16(2);
  const values: { name: string; value: number }[] = [];
  def.liveFields.forEach((name, i) => {
    const off = 4 + 2 * i;
    if (off + 1 < params.length) values.push({ name, value: u16(off) });
  });
  return { key: def.key, label: def.label, enabled, type, typeName: typeName(def, type), values, raw: params.slice() };
}

export interface SavedPreset {
  name: string;
  fxOrder: number[];
  blocks: BlockState[];
  /** DELAY time, u16 LE no offset 350 (confirmado: bate com o frame ao vivo 0x98). */
  delayTime: number;
  /** Byte 10: muito provavelmente o Preset Volume (0..100). O MooerManager lia como u16 "size". */
  volume: number;
  /** Byte 11: 0 ou 1, significado desconhecido. */
  flag11: number;
  raw: Uint8Array;
}

export const PRESET_SIZE = 512;

/** Decodifica os 512 bytes de um preset salvo. */
export function decodeSavedPreset(p: Uint8Array): SavedPreset {
  if (p.length < 100) throw new Error(`preset curto demais: ${p.length} bytes`);
  const blocks = BLOCKS.map((def, i) => {
    const o = 28 + 8 * i;
    const type = p[o];
    const values: { name: string; value: number }[] = [];
    def.savedFields.forEach((name, j) => {
      if (name) values.push({ name, value: p[o + 2 + j] });
    });
    return { key: def.key, label: def.label, enabled: p[o + 1] !== 0, type, typeName: typeName(def, type), values };
  });
  return {
    name: ascii(p.subarray(12, 28)).trim(),
    fxOrder: Array.from(p.subarray(0, 10)),
    blocks,
    delayTime: p.length > 351 ? p[350] | (p[351] << 8) : 0,
    volume: p[10],
    flag11: p[11],
    raw: p,
  };
}
