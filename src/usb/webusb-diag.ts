/**
 * Diagnóstico WebUSB — SOMENTE LEITURA.
 * Nenhum transferOut / controlTransferOut é feito aqui.
 * Os únicos passos que tocam o dispositivo são os da própria pilha USB:
 * open(), selectConfiguration() (só se nenhuma configuração estiver ativa),
 * claimInterface() e, opcionalmente, leitura (transferIn) do endpoint IN.
 */

import { CONTROL_INTERFACE, EP_IN, PACKET_SIZE, PRODUCT_ID, VENDOR_ID } from '../protocol/constants';
import { FrameAssembler, describeFrame, hex } from '../protocol/frame';
import type { EnvInfo } from './env';
import { errText, explainError } from './explain';
import type { Log } from '../ui/log';

const CLASS_NAMES: Record<number, string> = {
  0x00: 'por interface',
  0x01: 'Áudio',
  0x02: 'Comunicação (CDC)',
  0x03: 'HID',
  0x08: 'Armazenamento',
  0x0e: 'Vídeo',
  0xff: 'Específica do fabricante',
};
const PROTECTED = new Set([0x01, 0x03, 0x08, 0x0b, 0x0e, 0x10, 0xe0]);

const h4 = (n: number) => '0x' + n.toString(16).padStart(4, '0');
const h2 = (n: number) => '0x' + n.toString(16).padStart(2, '0');

export class WebUsbDiag {
  device: USBDevice | null = null;
  private claimed = false;
  private listening = false;

  constructor(private log: Log, private env: EnvInfo) {}

  async connect(): Promise<void> {
    const log = this.log;
    if (!this.env.hasUsb) {
      log.error('WebUSB não existe neste navegador (navigator.usb indefinido).');
      return;
    }
    log.info(`WebUSB: requestDevice({ filters: [{ vendorId: ${h4(VENDOR_ID)}, productId: ${h4(PRODUCT_ID)} }] })`);
    let dev: USBDevice;
    try {
      dev = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    } catch (e) {
      this.fail('requestDevice', e);
      return;
    }
    this.device = dev;
    log.ok('Dispositivo escolhido.');
    this.dumpDevice(dev);

    // open()
    try {
      log.info('open()…');
      await dev.open();
      log.ok('open() OK');
    } catch (e) {
      this.fail('open', e);
      return;
    }

    // selectConfiguration()
    try {
      if (!dev.configuration) {
        log.info('Nenhuma configuração ativa → selectConfiguration(1)…');
        await dev.selectConfiguration(1);
        log.ok('selectConfiguration(1) OK');
      } else {
        log.ok(`Configuração já ativa: ${dev.configuration.configurationValue} (selectConfiguration não é necessário)`);
      }
    } catch (e) {
      this.fail('selectConfiguration', e);
      return;
    }

    // claimInterface(3)
    try {
      log.info(`claimInterface(${CONTROL_INTERFACE}) — interface de controle da GE200…`);
      await dev.claimInterface(CONTROL_INTERFACE);
      this.claimed = true;
      log.ok(`claimInterface(${CONTROL_INTERFACE}) OK — interface liberada para uso via WebUSB!`);
    } catch (e) {
      this.fail('claimInterface', e);
      return;
    }
  }

  private dumpDevice(d: USBDevice): void {
    const log = this.log;
    log.data(
      [
        'Informações do dispositivo (WebUSB):',
        `  Fabricante: ${d.manufacturerName ?? '-'} | Produto: ${d.productName ?? '-'} | Série: ${d.serialNumber ?? '-'}`,
        `  VID:PID ${h4(d.vendorId)}:${h4(d.productId)} | USB ${d.usbVersionMajor}.${d.usbVersionMinor}.${d.usbVersionSubminor}` +
          ` | versão do dispositivo ${d.deviceVersionMajor}.${d.deviceVersionMinor}.${d.deviceVersionSubminor}`,
        `  Classe ${h2(d.deviceClass)}/${h2(d.deviceSubclass)}/${h2(d.deviceProtocol)} | aberto: ${d.opened}`,
        `  Configurações: ${d.configurations.length} | ativa: ${d.configuration?.configurationValue ?? 'nenhuma'}`,
      ].join('\n'),
    );
    for (const cfg of d.configurations) {
      const lines = [`Configuração ${cfg.configurationValue} "${cfg.configurationName ?? ''}" — ${cfg.interfaces.length} interfaces`];
      for (const itf of cfg.interfaces) {
        lines.push(`  Interface ${itf.interfaceNumber} (requisitada: ${itf.claimed})`);
        for (const alt of itf.alternates) {
          const cls = CLASS_NAMES[alt.interfaceClass] ?? '?';
          const prot = PROTECTED.has(alt.interfaceClass) ? ' [classe PROTEGIDA no WebUSB]' : '';
          lines.push(
            `    Alternate ${alt.alternateSetting}: classe ${h2(alt.interfaceClass)} ${cls}${prot}, ` +
              `sub ${h2(alt.interfaceSubclass)}, prot ${h2(alt.interfaceProtocol)}, "${alt.interfaceName ?? ''}"`,
          );
          for (const ep of alt.endpoints) {
            const addr = (ep.direction === 'in' ? 0x80 : 0) | ep.endpointNumber;
            lines.push(
              `      Endpoint ${h2(addr)}: nº ${ep.endpointNumber}, ${ep.direction === 'in' ? 'IN (pedaleira→host)' : 'OUT (host→pedaleira)'}, ` +
                `${ep.type}, pacote ${ep.packetSize} bytes`,
            );
          }
          if (alt.endpoints.length === 0) lines.push('      (sem endpoints)');
        }
      }
      log.data(lines.join('\n'));
    }
  }

  /** Lê pacotes do endpoint IN (0x81). Só leitura. */
  async listen(onStop: () => void): Promise<void> {
    const dev = this.device;
    if (!dev || !this.claimed) {
      this.log.warn('Escuta indisponível: a interface 3 não foi requisitada.');
      onStop();
      return;
    }
    this.listening = true;
    const asm = new FrameAssembler();
    this.log.info(`Escutando endpoint ${h2(EP_IN)} (somente leitura). Mexa na pedaleira (troque de preset, gire um knob)…`);
    while (this.listening && dev.opened) {
      try {
        const r = await dev.transferIn(EP_IN & 0x0f, PACKET_SIZE);
        if (r.data && r.data.byteLength) {
          const p = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          this.log.add('rx', `pacote ${p.length}B [${r.status}]: ${hex(p.subarray(0, Math.min(p.length, (p[0] ?? 0) + 1)))}`);
          for (const f of asm.pushPacket(p)) this.log.add('rx', '  frame ' + describeFrame(f));
        } else {
          this.log.warn(`transferIn status ${r.status}, sem dados`);
        }
      } catch (e) {
        if (this.listening) this.log.error('transferIn falhou: ' + errText(e));
        break;
      }
    }
    this.listening = false;
    onStop();
  }

  stopListening(): void {
    this.listening = false;
  }

  async disconnect(): Promise<void> {
    this.listening = false;
    const dev = this.device;
    if (!dev) return;
    try {
      if (this.claimed) await dev.releaseInterface(CONTROL_INTERFACE);
    } catch (e) {
      this.log.warn('releaseInterface: ' + errText(e));
    }
    try {
      if (dev.opened) await dev.close();
      this.log.ok('WebUSB: dispositivo fechado.');
    } catch (e) {
      this.log.warn('close: ' + errText(e));
    }
    this.claimed = false;
    this.device = null;
  }

  get canListen(): boolean {
    return this.claimed;
  }

  private fail(step: string, e: unknown): void {
    this.log.error(`${step} falhou → ${errText(e)}`);
    const ex = explainError(step, e, this.env);
    if (ex) this.log.warn('O que isso significa: ' + ex);
  }
}
