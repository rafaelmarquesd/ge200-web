/**
 * Pedidos de LEITURA (não alteram nada na pedaleira).
 * Comandos de escrita NÃO ficam aqui — virão nas fases 3/4, sempre com confirmação.
 */

import { Cmd } from './constants';
import { encodeFrame } from './frame';

/** 84 00 00 — o Mooer Studio manda duas vezes ao conectar. Resposta: 0x10 (e/ou 0x84). */
export const identifyRequest = (): Uint8Array => encodeFrame(Cmd.IdentifyRequest, [0x00, 0x00]);

/** E0 + 7 zeros — pede os 200 presets (0xA5) e o estado atual. */
export const patchListRequest = (): Uint8Array => encodeFrame(Cmd.PatchListRequest, [0, 0, 0, 0, 0, 0, 0]);
