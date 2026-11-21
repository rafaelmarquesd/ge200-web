/**
 * Codificação e decodificação de frames da GE200.
 *
 * Camadas (veja PROTOCOL.md):
 *  - Frame:   AA 55 | LEN (u16 LE) | CMD | PARAMS... | CRC (u16 BE)
 *             LEN = 1 + nº de PARAMS (conta o CMD, não conta o CRC)
 *             CRC = crc16(LEN_LO, LEN_HI, CMD, PARAMS...)
 *  - Pacote USB (relatório de 64 bytes): [N] [N bytes do fluxo] [preenchimento]
 *             N <= 63. Frames grandes são quebrados em vários pacotes.
 *
 * Este módulo é puro (sem I/O). Nada aqui envia bytes para o aparelho.
 */

import { crc16 } from './crc';
import { CMD_NAMES, PACKET_SIZE, SYNC0, SYNC1 } from './constants';

export interface Frame {
  cmd: number;
  /** Bytes depois do CMD, sem o CRC. */
  params: Uint8Array;
  /** CRC recebido. */
  crc: number;
  /** true se o CRC recebido bate com o calculado. */
  crcOk: boolean;
}

/** Monta um frame completo (sem o byte de tamanho do pacote USB). */
export function encodeFrame(cmd: number, params: ArrayLike<number> = []): Uint8Array {
  const len = 1 + params.length;
  const out = new Uint8Array(4 + len + 2);
  out[0] = SYNC0;
  out[1] = SYNC1;
  out[2] = len & 0xff;
  out[3] = (len >> 8) & 0xff;
  out[4] = cmd;
  out.set(Array.from(params), 5);
  const c = crc16(out.subarray(2, 4 + len));
  out[4 + len] = c >> 8;
  out[4 + len + 1] = c & 0xff;
  return out;
}

/**
 * Quebra um fluxo de bytes em pacotes USB de 64 bytes:
 * cada pacote = [n] + n bytes (n <= 63), preenchido com zeros.
 */
export function packetize(stream: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let off = 0; off < stream.length; off += PACKET_SIZE - 1) {
    const chunk = stream.subarray(off, off + PACKET_SIZE - 1);
    const p = new Uint8Array(PACKET_SIZE);
    p[0] = chunk.length;
    p.set(chunk, 1);
    packets.push(p);
  }
  return packets;
}

/**
 * Remonta frames a partir de pacotes USB recebidos.
 * Tolerante: descarta lixo até achar AA 55, verifica o CRC.
 */
export class FrameAssembler {
  private buf: number[] = [];

  /** Alimenta um pacote de 64 bytes; devolve os frames completados. */
  pushPacket(packet: Uint8Array): Frame[] {
    if (packet.length < 1) return [];
    const n = Math.min(packet[0], packet.length - 1);
    for (let i = 1; i <= n; i++) this.buf.push(packet[i]);
    return this.drain();
  }

  /** Bytes pendentes (frame incompleto). */
  get pending(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = [];
  }

  private drain(): Frame[] {
    const frames: Frame[] = [];
    for (;;) {
      // procura o preâmbulo
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === SYNC0 && this.buf[i + 1] === SYNC1) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        // guarda só um possível AA final
        this.buf = this.buf.length && this.buf[this.buf.length - 1] === SYNC0 ? [SYNC0] : [];
        return frames;
      }
      if (start > 0) this.buf.splice(0, start);
      if (this.buf.length < 4) return frames;
      const len = this.buf[2] | (this.buf[3] << 8);
      const total = 4 + len + 2;
      if (len === 0 || len > 0x1000) {
        // tamanho absurdo: descarta este AA e tenta de novo
        this.buf.splice(0, 1);
        continue;
      }
      if (this.buf.length < total) return frames;
      const bytes = Uint8Array.from(this.buf.splice(0, total));
      const crcRx = (bytes[total - 2] << 8) | bytes[total - 1];
      const crcCalc = crc16(bytes.subarray(2, 4 + len));
      frames.push({
        cmd: bytes[4],
        params: bytes.slice(5, 4 + len),
        crc: crcRx,
        crcOk: crcRx === crcCalc,
      });
    }
  }
}

export function cmdName(cmd: number): string {
  return CMD_NAMES[cmd] ?? 'desconhecido';
}

export function hex(bytes: ArrayLike<number>, max = Infinity): string {
  const parts: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) parts.push(bytes[i].toString(16).padStart(2, '0').toUpperCase());
  let s = parts.join(' ');
  if (bytes.length > n) s += ` … (+${bytes.length - n} bytes)`;
  return s;
}

/** Texto ASCII imprimível (para nomes de preset etc.). */
export function ascii(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return s;
}

/** Resumo de um frame recebido para o log. */
export function describeFrame(f: Frame): string {
  let s = `0x${f.cmd.toString(16).toUpperCase().padStart(2, '0')} ${cmdName(f.cmd)} ` +
    `(${f.params.length} bytes, CRC ${f.crcOk ? 'ok' : 'INVÁLIDO'})`;
  if (f.cmd === 0x10 && f.params.length >= 17) {
    s += ` versão="${ascii(f.params.subarray(1, 6))}" nome="${ascii(f.params.subarray(6, 17))}"`;
  } else if (f.cmd === 0x84 && f.params.length >= 16) {
    s += ` versão="${ascii(f.params.subarray(0, 5))}" nome="${ascii(f.params.subarray(5, 16))}"`;
  } else if (f.cmd === 0xa6 && f.params.length >= 1) {
    s += ` preset=${f.params[0]} (exibido como ${f.params[0] + 1})`;
  } else if (f.cmd === 0xa5 && f.params.length >= 1 + 28) {
    s += ` preset=${f.params[0]} nome="${ascii(f.params.subarray(1 + 12, 1 + 28))}" volume?=${f.params[1 + 10]}`;
  } else if (f.cmd === 0x86 && f.params.length >= 28) {
    s += ` nome="${ascii(f.params.subarray(12, 28))}" volume?=${f.params[10]}`;
  } else if (f.cmd === 0xa2 && f.params.length >= 1) {
    s += ` valor=${f.params[0]}`;
  } else if (f.cmd === 0x82 && f.params.length >= 1) {
    s += ` menu=${f.params[0]}`;
  }
  return s;
}
