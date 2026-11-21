/**
 * Diagnóstico WebHID — SOMENTE LEITURA.
 * Nenhum sendReport / sendFeatureReport é feito aqui.
 * open() e a escuta de "inputreport" não enviam nada para a pedaleira.
 */

import { PRODUCT_ID, VENDOR_ID } from '../protocol/constants';
import { FrameAssembler, describeFrame, hex } from '../protocol/frame';
import type { EnvInfo } from './env';
import { errText, explainError } from './explain';
import type { Log } from '../ui/log';

const h4 = (n: number) => '0x' + n.toString(16).padStart(4, '0');

export class WebHidDiag {
  device: HIDDevice | null = null;
  private asm = new FrameAssembler();
  private onInput = (ev: HIDInputReportEvent) => this.handleInput(ev);
  private listening = false;

  constructor(private log: Log, private env: EnvInfo) {}

  async connect(): Promise<void> {
    const log = this.log;
    if (!this.env.hasHid) {
      log.error('WebHID não existe neste navegador (navigator.hid indefinido).');
      return;
    }
    log.info(`WebHID: requestDevice({ filters: [{ vendorId: ${h4(VENDOR_ID)}, productId: ${h4(PRODUCT_ID)} }] })`);
    let list: HIDDevice[];
    try {
      list = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    } catch (e) {
      this.fail('requestDevice', e);
      return;
    }
    if (!list.length) {
      log.error('requestDevice retornou lista vazia (nenhum dispositivo escolhido).');
      log.warn('O que isso significa: ou você cancelou, ou a GE200 não apareceu. Confira o cabo e se a pedaleira está ligada.');
      return;
    }
    log.ok(`${list.length} dispositivo(s) HID escolhido(s).`);
    list.forEach((d, i) => this.dumpDevice(d, i));
    // Escolhe o que tem relatório de saída (interface de controle)
    const dev = list.find((d) => d.collections.some((c) => (c.outputReports?.length ?? 0) > 0)) ?? list[0];
    this.device = dev;

    try {
      log.info(`open() em "${dev.productName}"…`);
      await dev.open();
      log.ok('open() OK — a interface HID de controle está acessível pelo WebHID!');
    } catch (e) {
      this.fail('open', e);
      return;
    }
  }

  private dumpDevice(d: HIDDevice, i: number): void {
    const lines = [
      `Dispositivo HID #${i}: "${d.productName}" VID:PID ${h4(d.vendorId)}:${h4(d.productId)} aberto: ${d.opened}`,
      `  Coleções: ${d.collections.length}`,
    ];
    for (const c of d.collections) {
      lines.push(`  Coleção usagePage ${h4(c.usagePage ?? 0)} usage ${h4(c.usage ?? 0)} type ${c.type}`);
      const dumpReports = (kind: string, reps?: HIDReportInfo[]) => {
        for (const r of reps ?? []) {
          let bits = 0;
          const items = (r.items ?? []).map((it) => {
            bits += (it.reportSize ?? 0) * (it.reportCount ?? 0);
            return `size ${it.reportSize}×count ${it.reportCount}` +
              (it.usages?.length ? ` usages[${it.usages.map((u) => '0x' + (u >>> 0).toString(16).padStart(8, '0')).join(',')}]` : '') +
              (it.usageMinimum !== undefined ? ` usageMin ${it.usageMinimum} max ${it.usageMaximum}` : '') +
              ` lógico ${it.logicalMinimum}..${it.logicalMaximum}`;
          });
          lines.push(`    ${kind} reportId ${r.reportId}: ${bits / 8} bytes`);
          items.forEach((s) => lines.push(`      item: ${s}`));
        }
      };
      dumpReports('INPUT  ', c.inputReports);
      dumpReports('OUTPUT ', c.outputReports);
      dumpReports('FEATURE', c.featureReports);
      if (c.children?.length) lines.push(`    (${c.children.length} sub-coleções)`);
    }
    this.log.data(lines.join('\n'));
  }

  listen(): void {
    if (!this.device?.opened) {
      this.log.warn('Escuta indisponível: dispositivo HID não aberto.');
      return;
    }
    if (this.listening) return;
    this.asm.reset();
    this.device.addEventListener('inputreport', this.onInput);
    this.listening = true;
    this.log.info('Escutando relatórios de entrada HID (somente leitura). Mexa na pedaleira (troque de preset, gire um knob)…');
  }

  stopListening(): void {
    if (this.device && this.listening) this.device.removeEventListener('inputreport', this.onInput);
    if (this.listening) this.log.info('Escuta HID parada.');
    this.listening = false;
  }

  private handleInput(ev: HIDInputReportEvent): void {
    const p = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    const used = Math.min(p.length, (p[0] ?? 0) + 1);
    this.log.add('rx', `reportId ${ev.reportId}, ${p.length}B: ${hex(p.subarray(0, used))}`);
    // Se o relatório não tiver reportId, o byte 0 é o tamanho do pedaço (formato MooerManager).
    for (const f of this.asm.pushPacket(p)) this.log.add('rx', '  frame ' + describeFrame(f));
  }

  async disconnect(): Promise<void> {
    this.stopListening();
    const dev = this.device;
    if (!dev) return;
    try {
      if (dev.opened) await dev.close();
      this.log.ok('WebHID: dispositivo fechado.');
    } catch (e) {
      this.log.warn('close: ' + errText(e));
    }
    this.device = null;
  }

  get isOpen(): boolean {
    return !!this.device?.opened;
  }

  private fail(step: string, e: unknown): void {
    this.log.error(`${step} falhou → ${errText(e)}`);
    const ex = explainError(step, e, this.env);
    if (ex) this.log.warn('O que isso significa: ' + ex);
  }
}
