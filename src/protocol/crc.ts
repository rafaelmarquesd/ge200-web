/**
 * Checksum dos frames da GE200.
 *
 * Portado de MooerManager (mooer.lib/MooerParser.cc, calculateChecksum), GPL-2.0.
 * O original usa uma tabela de 256 entradas do polinômio 0x1021 (CRC-16/CCITT,
 * não refletido, valor inicial 0x0000) e inverte o resultado no fim (~chk).
 * Esse conjunto de parâmetros é conhecido como CRC-16/GSM.
 *
 * Confirmado contra um pacote real capturado que aparece comentado no
 * MooerManager:  0B AA 55 05 00 82 00 00 00 00 E0 0B  -> CRC 0xE00B.
 */

const TABLE: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 8;
    for (let i = 0; i < 8; i++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    t[n] = c;
  }
  return t;
})();

/** CRC sobre os bytes dados (no protocolo: LEN_LO, LEN_HI, CMD, PARAMS...). */
export function crc16(bytes: ArrayLike<number>): number {
  let chk = 0;
  for (let i = 0; i < bytes.length; i++) {
    chk = (TABLE[((chk >> 8) ^ bytes[i]) & 0xff] ^ (chk << 8)) & 0xffff;
  }
  return ~chk & 0xffff;
}
