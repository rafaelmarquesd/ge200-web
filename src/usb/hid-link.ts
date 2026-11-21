/**
 * Ligação com a GE200 via WebHID: envia frames (relatório de saída de 64 bytes, sem report ID)
 * e remonta os frames recebidos. Toda escrita passa por send(), que registra o pacote em hex.
 */

import { FrameAssembler, describeFrame, hex, packetize, type Frame } from '../protocol/frame';
import type { Log } from '../ui/log';
import type { WriteCommand } from '../protocol/commands';

export type FrameListener = (f: Frame) => void;

export class Ge200Link {
  private asm = new FrameAssembler();
  private listeners = new Set<FrameListener>();
  private onInput = (ev: HIDInputReportEvent) => this.handleInput(ev);
  /** Se true, registra todos os pacotes brutos recebidos em hex. */
  verbose = false;
  /** Frames recebidos (para exportar o dump). */
  readonly received: { t: string; cmd: number; crcOk: boolean; hex: string }[] = [];
  packetsRx = 0;

  constructor(readonly device: HIDDevice, private log: Log) {
    device.addEventListener('inputreport', this.onInput);
  }

  close(): void {
    this.device.removeEventListener('inputreport', this.onInput);
    this.listeners.clear();
  }

  onFrame(fn: FrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Envia um frame já codificado (AA 55 ...), quebrando em relatórios de 64 bytes. */
  async send(frame: Uint8Array, label: string): Promise<void> {
    const packets = packetize(frame);
    this.log.add('tx', `${label}: ${hex(frame)}`);
    for (const p of packets) {
      if (this.verbose) this.log.add('tx', `  relatório 64B: ${hex(p.subarray(0, p[0] + 1))}`);
      await this.device.sendReport(0, p);
    }
  }

  /**
   * Envia um comando de ESCRITA. Em dry-run só registra o que SERIA enviado.
   * A confirmação do usuário é responsabilidade da UI (sempre antes de chamar isto).
   */
  async sendWrite(cmd: WriteCommand, dryRun: boolean): Promise<boolean> {
    if (dryRun) {
      this.log.add('tx', `DRY-RUN (NÃO enviado) ${cmd.label} [${cmd.risk}]: ${hex(cmd.frame)}\n` +
        packetize(cmd.frame).map((p) => `  relatório 64B: ${hex(p.subarray(0, p[0] + 1))}`).join('\n'));
      return false;
    }
    await this.send(cmd.frame, `ESCRITA ${cmd.label} [${cmd.risk}]`);
    return true;
  }

  /** Espera um frame que satisfaça pred, ou null depois de timeoutMs. */
  waitFor(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | null> {
    return new Promise((resolve) => {
      const off = this.onFrame((f) => {
        if (pred(f)) {
          clearTimeout(timer);
          off();
          resolve(f);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  private handleInput(ev: HIDInputReportEvent): void {
    const p = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    this.packetsRx++;
    if (this.verbose) {
      this.log.add('rx', `relatório id ${ev.reportId} ${p.length}B: ${hex(p.subarray(0, Math.min(p.length, (p[0] ?? 0) + 1)))}`);
    }
    for (const f of this.asm.pushPacket(p)) {
      const full = [f.cmd, ...f.params];
      this.received.push({ t: new Date().toISOString(), cmd: f.cmd, crcOk: f.crcOk, hex: hex(full) });
      if (f.cmd === 0xa5) {
        // 200 presets: uma linha curta cada
        this.log.add('rx', 'frame ' + describeFrame(f));
      } else {
        this.log.add('rx', `frame ${describeFrame(f)}\n${hex(full, 72)}`);
      }
      if (!f.crcOk) this.log.warn('CRC inválido no frame acima — pode ser erro de remontagem, guarde o log.');
      for (const fn of [...this.listeners]) {
        try {
          fn(f);
        } catch (e) {
          this.log.error('erro ao processar frame: ' + String(e));
        }
      }
    }
  }
}
