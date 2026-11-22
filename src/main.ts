import './ui/style.css';
import { Log, copyText, downloadText } from './ui/log';
import { detectEnv, envSummary, envWarnings } from './usb/env';
import { WebUsbDiag } from './usb/webusb-diag';
import { WebHidDiag } from './usb/webhid-diag';
import { errText } from './usb/explain';
import { PRODUCT_ID, VENDOR_ID } from './protocol/constants';
import { Ge200Link } from './usb/hid-link';
import { Reader } from './ui/reader';
import { Editor } from './ui/editor';
import { Leveler } from './ui/leveler';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const env = detectEnv();
const log = new Log($('log'));
log.setHeader(() =>
  [
    '=== GE200 Web — log de diagnóstico ===',
    `Versão do app: ${__APP_VERSION__} (build ${__BUILD_TIME__})`,
    `Página: ${location.href}`,
    `Data: ${new Date().toISOString()}`,
    envSummary(env),
  ].join('\n'),
);

// --- Ambiente ---
$('env').textContent = envSummary(env);
const warnBox = $('warnings');
for (const w of envWarnings(env)) {
  const d = document.createElement('div');
  d.className = `warn-box ${w.level}`;
  d.textContent = w.text;
  warnBox.appendChild(d);
}

log.info(`GE200 Web ${__APP_VERSION__} — diagnóstico (somente leitura, nenhum comando é enviado).`);
log.data(envSummary(env));
for (const w of envWarnings(env)) log.add(w.level === 'error' ? 'error' : w.level === 'warn' ? 'warn' : 'info', w.text);

// --- Botões ---
const usb = new WebUsbDiag(log, env);
const hid = new WebHidDiag(log, env);
let active: 'usb' | 'hid' | null = null;
let link: Ge200Link | null = null;
const reader = new Reader($('reader'), log, __APP_VERSION__);
const editor = new Editor($('editor'), reader, log, __APP_VERSION__);
new Leveler($('leveler'), reader, editor, log);

function dropLink(): void {
  link?.close();
  link = null;
  reader.detach();
}
let listening = false;

const btnHid = $<HTMLButtonElement>('btn-hid');
const btnUsb = $<HTMLButtonElement>('btn-usb');
const btnListen = $<HTMLButtonElement>('btn-listen');
const btnDisc = $<HTMLButtonElement>('btn-disc');
const status = $('status');

btnHid.disabled = !env.hasHid;
btnUsb.disabled = !env.hasUsb;
if (!env.hasHid) btnHid.textContent = 'WebHID indisponível';
if (!env.hasUsb) btnUsb.textContent = 'WebUSB indisponível';

function refresh(): void {
  const canListen = active === 'usb' ? usb.canListen : false;
  btnListen.disabled = !canListen;
  btnListen.textContent = listening ? 'Parar escuta' : 'Escutar a pedaleira';
  btnDisc.disabled = active === null;
  btnHid.disabled = !env.hasHid || active !== null;
  btnUsb.disabled = !env.hasUsb || active !== null;
  status.textContent =
    active === null
      ? 'Nenhum dispositivo conectado.'
      : active === 'hid' && link
      ? 'Conectado via WebHID — ouvindo a pedaleira. Use a seção Leitura abaixo.'
      : `Conectado via ${active === 'usb' ? 'WebUSB' : 'WebHID'}` +
        (canListen ? ' — pronto para escutar.' : ' — mas sem acesso à interface de controle (veja o log).');
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error('Erro inesperado: ' + errText(e));
  }
  refresh();
}

btnHid.onclick = () =>
  guard(async () => {
    await hid.connect();
    if (hid.device) active = 'hid';
    if (hid.device?.opened) {
      link = new Ge200Link(hid.device, log);
      reader.attach(link);
      log.info('Ouvindo a pedaleira (relatórios de entrada). Agora use "Identificar" ou "Ler presets e parâmetros".');
    }
  });

btnUsb.onclick = () =>
  guard(async () => {
    await usb.connect();
    if (usb.device) active = 'usb';
  });

btnListen.onclick = () =>
  guard(async () => {
    if (listening) {
      listening = false;
      if (active === 'usb') usb.stopListening();
      else hid.stopListening();
      return;
    }
    listening = true;
    if (active === 'usb') {
      void usb.listen(() => {
        listening = false;
        refresh();
      });
    } else {
      hid.listen();
    }
  });

btnDisc.onclick = () =>
  guard(async () => {
    listening = false;
    if (active === 'usb') await usb.disconnect();
    if (active === 'hid') {
      dropLink();
      await hid.disconnect();
    }
    active = null;
  });

// --- Log ---
function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

$('btn-copy').onclick = async () => {
  const ok = await copyText(log.text());
  toast(ok ? 'Log copiado!' : 'Não consegui copiar — use "Baixar .txt"');
};
$('btn-save').onclick = () => downloadText(`ge200-log-${Date.now()}.txt`, log.text());
$('btn-clear').onclick = () => log.clear();

// --- Dispositivos já autorizados e eventos de conexão ---
async function listKnown(): Promise<void> {
  if (env.hasUsb) {
    try {
      const ds = await navigator.usb.getDevices();
      log.info(`WebUSB getDevices(): ${ds.length} dispositivo(s) já autorizado(s)` +
        (ds.length ? ': ' + ds.map((d) => `${d.productName} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`).join(', ') : ''));
    } catch (e) {
      log.warn('WebUSB getDevices(): ' + errText(e));
    }
    navigator.usb.addEventListener('connect', (ev) => log.info(`WebUSB: dispositivo conectado no cabo: ${ev.device.productName}`));
    navigator.usb.addEventListener('disconnect', (ev) => {
      log.warn(`WebUSB: dispositivo desconectado: ${ev.device.productName}`);
      if (active === 'usb' && ev.device === usb.device) {
        active = null;
        listening = false;
        usb.device = null;
        refresh();
      }
    });
  }
  if (env.hasHid) {
    try {
      const ds = await navigator.hid.getDevices();
      log.info(`WebHID getDevices(): ${ds.length} dispositivo(s) já autorizado(s)` +
        (ds.length ? ': ' + ds.map((d) => `${d.productName} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`).join(', ') : ''));
    } catch (e) {
      log.warn('WebHID getDevices(): ' + errText(e));
    }
    navigator.hid.addEventListener('connect', (ev) => log.info(`WebHID: dispositivo conectado no cabo: ${ev.device.productName}`));
    navigator.hid.addEventListener('disconnect', (ev) => {
      log.warn(`WebHID: dispositivo desconectado: ${ev.device.productName}`);
      if (active === 'hid' && ev.device === hid.device) {
        dropLink();
        active = null;
        listening = false;
        hid.device = null;
        refresh();
      }
    });
  }
  log.info(`Filtro usado: VID 0x${VENDOR_ID.toString(16).padStart(4, '0')} PID 0x${PRODUCT_ID.toString(16).padStart(4, '0')} (Mooer GE200).`);
}

void listKnown();
refresh();
