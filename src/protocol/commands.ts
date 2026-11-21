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
