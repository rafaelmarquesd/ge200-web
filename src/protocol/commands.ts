/**
 * Comandos de ESCRITA. Cada um tem um nível de risco. A UI só envia depois de confirmação
 * explícita do usuário, e respeita o modo dry-run.
 */

import { Cmd } from './constants';
import { encodeFrame } from './frame';

export type Risk = 'volatil' | 'permanente';

export interface WriteCommand {
  label: string;
  risk: Risk;
  frame: Uint8Array;
}

export const NUM_PRESETS = 200;

/**
 * A6 idx — troca o preset ativo. Não grava nada na memória: é o mesmo que pisar no footswitch.
 * Confirmado: MooerManager SendPresetChange, e a própria pedaleira manda A6 idx quando você troca no pé.
 */
export function presetChange(idx: number): WriteCommand {
  if (!Number.isInteger(idx) || idx < 0 || idx >= NUM_PRESETS) throw new RangeError(`índice de preset inválido: ${idx}`);
  return { label: `Trocar para o preset ${String(idx + 1).padStart(3, '0')} (A6 ${idx})`, risk: 'volatil', frame: encodeFrame(Cmd.ActivePatch, [idx]) };
}

/** Tamanho (bytes após o CMD) de cada bloco ao vivo — DeviceFormat do MooerManager. */
export const LIVE_BLOCK_SIZE: Record<number, number> = {
  0x90: 12, 0x91: 10, 0x93: 16, 0x94: 12, 0x95: 10, 0x96: 22, 0x97: 14, 0x98: 16, 0x99: 12,
};

/** Menu do display que o MooerManager seleciona antes de editar cada bloco (SwitchMenuIfDifferent). */
export const BLOCK_MENU: Record<number, number> = { 0x90: 1, 0x91: 2, 0x93: 3, 0x94: 4, 0x95: 5, 0x96: 6, 0x97: 7 };

/**
 * 82 menu — troca a tela mostrada no display (FX=1, OD=2, AMP=3, CAB=4, NS=5, EQ=6, MOD=7).
 * Confirmado: MooerManager SwitchMenu, usado antes de cada edição de bloco.
 */
export function menuSwitch(menu: number): WriteCommand {
  if (!Object.values(BLOCK_MENU).includes(menu) && menu !== 0) throw new RangeError(`menu não suportado: ${menu}`);
  return { label: `Mostrar menu ${menu} no display (82 ${menu})`, risk: 'volatil', frame: encodeFrame(Cmd.Menu, [menu]) };
}

/**
 * 90..97 + struct — altera um bloco do preset ativo em tempo real (buffer de edição, não salva).
 * Confirmado: MooerManager SetFX/SetDS/SetAmplifier/SetCabinet/SetNoiseGate/SetEQ/SetModulator.
 * DELAY (98) e REVERB (99) NÃO são aceitos: o MooerManager nunca os envia.
 */
export function setBlock(cmd: number, raw: Uint8Array, label: string): WriteCommand {
  if (!(cmd in BLOCK_MENU)) throw new RangeError(`bloco 0x${cmd.toString(16)} não pode ser editado`);
  if (raw.length !== LIVE_BLOCK_SIZE[cmd]) throw new RangeError(`bloco 0x${cmd.toString(16)}: ${raw.length} bytes, esperado ${LIVE_BLOCK_SIZE[cmd]}`);
  const type = (raw[2] << 8) | raw[3];
  if (type < 1) throw new RangeError('tipo inválido (0)');
  // "The GE-200 crashes if s.type is invalid" (MooerManager): MOD só aceita 1..20 aqui.
  if (cmd === 0x97 && type > 20) throw new RangeError(`tipo de MOD ${type} travaria a pedaleira (máx. 20)`);
  return { label, risk: 'volatil', frame: encodeFrame(cmd, raw) };
}

/**
 * 83 + 512 bytes — carrega um preset completo no preset ativo (buffer de edição), SEM salvar.
 * Provável (MooerManager LoadMoPreset, botão "Import Preset"; o salvar é um comando separado).
 * Usado aqui só para mudar o Preset Volume (byte 10) partindo dos bytes que a própria pedaleira mandou.
 */
export function loadPresetToBuffer(preset: Uint8Array, label: string): WriteCommand {
  if (preset.length !== 512) throw new RangeError(`preset deve ter 512 bytes (tem ${preset.length})`);
  if (preset[10] > 100) throw new RangeError(`volume ${preset[10]} fora de 0..100`);
  return { label, risk: 'volatil', frame: encodeFrame(Cmd.Preset, preset) };
}

/*
 * NÃO IMPLEMENTADO DE PROPÓSITO: A8 (StorePatch / salvar na memória).
 * O MooerManager manda "A8 A5 <nome 15 bytes>" e ignora o índice do preset: não sabemos se o A5 é
 * "salvar no ativo" ou o slot 165. Até confirmar, o salvamento é feito no próprio botão da pedaleira.
 */
