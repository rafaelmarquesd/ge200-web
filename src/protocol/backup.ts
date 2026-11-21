/** Backup dos presets: formato do arquivo, exportação .mo e comparação. Puro, sem I/O. */

import { hex } from './frame';
import { BLOCKS } from './blocks';

export const BACKUP_FORMAT = 'ge200-web-backup';

export interface BackupPreset {
  index: number;
  name: string;
  volume: number;
  hex: string;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  date: string;
  appVersion: string;
  device: { name: string; version: string } | null;
  activeIdx: number | null;
  presets: BackupPreset[];
  /** Outros frames de estado (A1 sistema, A3 pedal, A4, 85/E3 nomes USER), em hex, só para referência. */
  extras: Record<string, string>;
}

export function makeBackup(args: {
  appVersion: string;
  device: Backup['device'];
  activeIdx: number | null;
  presets: { name: string; volume: number; raw: Uint8Array }[];
  extras: Record<string, string>;
}): Backup {
  if (args.presets.length !== 200) throw new Error(`backup precisa dos 200 presets (tenho ${args.presets.length})`);
  return {
    format: BACKUP_FORMAT,
    version: 1,
    date: new Date().toISOString(),
    appVersion: args.appVersion,
    device: args.device,
    activeIdx: args.activeIdx,
    presets: args.presets.map((p, index) => ({ index, name: p.name, volume: p.volume, hex: hex(p.raw) })),
    extras: args.extras,
  };
}

export function hexToBytes(h: string): Uint8Array {
  const parts = h.trim().split(/\s+/).filter(Boolean);
  return Uint8Array.from(parts.map((b) => {
    const v = parseInt(b, 16);
    if (Number.isNaN(v) || v > 255) throw new Error(`byte inválido: ${b}`);
    return v;
  }));
}

/** Lê e valida um backup (JSON). Lança erro em português se for inválido. */
export function parseBackup(text: string): Backup {
  let o: Backup;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('o arquivo não é um JSON válido');
  }
  if (o?.format !== BACKUP_FORMAT) throw new Error('não é um backup do GE200 Web');
  if (!Array.isArray(o.presets) || o.presets.length !== 200) throw new Error('backup sem os 200 presets');
  o.presets.forEach((p, i) => {
    if (p.index !== i || hexToBytes(p.hex).length !== 512) throw new Error(`preset ${i} inválido no backup`);
  });
  return o;
}

/** Arquivo .mo (2048 bytes, preset em 0x200), o formato de exportação do Mooer Studio. */
export function toMo(preset: Uint8Array): Uint8Array {
  if (preset.length !== 512) throw new Error('preset deve ter 512 bytes');
  const mo = new Uint8Array(0x800);
  mo.set(preset, 0x200);
  return mo;
}

export interface PresetDiff {
  index: number;
  name: string;
  changes: { offset: number; before: number; after: number }[];
}

/** Compara presets (bytes) de um backup com os atuais. */
export function diffPresets(before: Uint8Array[], after: Uint8Array[], names: string[]): PresetDiff[] {
  const out: PresetDiff[] = [];
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i];
    const b = after[i];
    const changes: PresetDiff['changes'] = [];
    for (let o = 0; o < Math.max(a.length, b.length); o++) {
      if (a[o] !== b[o]) changes.push({ offset: o, before: a[o], after: b[o] });
    }
    if (changes.length) out.push({ index: i, name: names[i] ?? '', changes });
  }
  return out;
}

/** Descrição legível de um offset do preset. */
export function offsetName(o: number): string {
  if (o < 10) return `ordem dos efeitos[${o}]`;
  if (o === 10) return 'VOLUME do preset';
  if (o === 11) return 'byte 11';
  if (o < 28) return 'nome';
  if (o < 100) {
    const def = BLOCKS[Math.floor((o - 28) / 8)];
    const k = (o - 28) % 8;
    return `${def.label} ${k === 0 ? 'tipo' : k === 1 ? 'on/off' : def.savedFields[k - 2] ?? `byte ${k}`}`;
  }
  if (o >= 344 && o <= 349) return `EQ freq ${Math.floor((o - 344) / 2) + 1}`;
  if (o === 350 || o === 351) return 'DELAY time';
  if (o === 352 || o === 353) return 'DELAY p5';
  return `offset ${o}`;
}
