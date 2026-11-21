import { describe, expect, it } from 'vitest';
import { crc16 } from './crc';
import { FrameAssembler, encodeFrame, hex, packetize, describeFrame } from './frame';

const bytes = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));

describe('crc16 (CRC-16/GSM)', () => {
  it('bate com o pacote real capturado no MooerManager (SendPresetChange, comentário msg2)', () => {
    // Pacote USB capturado: 0B AA 55 05 00 82 00 00 00 00 E0 0B
    expect(crc16(bytes('05 00 82 00 00 00 00'))).toBe(0xe00b);
  });
  it('valor de verificação padrão do CRC-16/GSM', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0xce3c);
  });
});

describe('encodeFrame', () => {
  it('reproduz byte a byte o pacote capturado', () => {
    const f = encodeFrame(0x82, [0, 0, 0, 0]);
    expect(hex(f)).toBe('AA 55 05 00 82 00 00 00 00 E0 0B');
    const [p] = packetize(f);
    expect(p.length).toBe(64);
    expect(hex(p.subarray(0, 12))).toBe('0B AA 55 05 00 82 00 00 00 00 E0 0B');
    expect([...p.subarray(12)].every((b) => b === 0)).toBe(true);
  });
  it('identify request (84 00 00) tem o layout esperado', () => {
    const f = encodeFrame(0x84, [0, 0]);
    expect(hex(f.subarray(0, 7))).toBe('AA 55 03 00 84 00 00');
    expect(f.length).toBe(9);
    expect(crc16(f.subarray(2, 7))).toBe((f[7] << 8) | f[8]);
  });
  it('troca de preset: A6 idx', () => {
    const f = encodeFrame(0xa6, [5]);
    expect(hex(f.subarray(0, 6))).toBe('AA 55 02 00 A6 05');
  });
});

describe('packetize', () => {
  it('quebra em pedaços de 63 bytes com prefixo de tamanho', () => {
    const stream = new Uint8Array(130).map((_, i) => i & 0xff);
    const ps = packetize(stream);
    expect(ps.map((p) => p[0])).toEqual([63, 63, 4]);
    expect(ps[1][1]).toBe(63);
    expect(ps[2][4]).toBe(129);
  });
});

describe('FrameAssembler', () => {
  it('decodifica o pacote capturado', () => {
    const a = new FrameAssembler();
    const [f] = a.pushPacket(packetize(bytes('AA 55 05 00 82 00 00 00 00 E0 0B'))[0]);
    expect(f.cmd).toBe(0x82);
    expect(f.crcOk).toBe(true);
    expect([...f.params]).toEqual([0, 0, 0, 0]);
  });

  it('remonta um preset (A5) de 512 bytes vindo em vários pacotes', () => {
    const preset = new Uint8Array(512);
    preset.set(new TextEncoder().encode('CLEAN TONE'), 12);
    const frame = encodeFrame(0xa5, [7, ...preset]);
    const a = new FrameAssembler();
    const out = packetize(frame).flatMap((p) => a.pushPacket(p));
    expect(out).toHaveLength(1);
    expect(out[0].cmd).toBe(0xa5);
    expect(out[0].params.length).toBe(513);
    expect(out[0].crcOk).toBe(true);
    expect(describeFrame(out[0])).toContain('nome="CLEAN TONE"');
    expect(a.pending).toBe(0);
  });

  it('marca CRC inválido', () => {
    const f = encodeFrame(0xa6, [3]);
    f[f.length - 1] ^= 0xff;
    const [r] = new FrameAssembler().pushPacket(packetize(f)[0]);
    expect(r.crcOk).toBe(false);
  });

  it('ignora lixo antes do preâmbulo e aceita vários frames no mesmo pacote', () => {
    const s = Uint8Array.from([0x01, 0x02, ...encodeFrame(0xa6, [1]), ...encodeFrame(0xa2, [50])]);
    const r = new FrameAssembler().pushPacket(packetize(s)[0]);
    expect(r.map((f) => f.cmd)).toEqual([0xa6, 0xa2]);
  });

  it('decodifica a resposta de identificação (0x10) como o MooerManager', () => {
    // Layout do pacote bruto lido pelo MooerManager: versão em [7..12), nome em [12..23)
    const params = [0x00, ...new TextEncoder().encode('2.0.4'), ...new TextEncoder().encode('MOOER_GE200')];
    const p = packetize(encodeFrame(0x10, params))[0];
    expect(new TextDecoder().decode(p.subarray(7, 12))).toBe('2.0.4');
    expect(new TextDecoder().decode(p.subarray(12, 23))).toBe('MOOER_GE200');
    const [f] = new FrameAssembler().pushPacket(p);
    expect(describeFrame(f)).toContain('versão="2.0.4" nome="MOOER_GE200"');
  });
});
