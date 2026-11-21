/** Detecção do ambiente: navegador, sistema, HTTPS, WebUSB, WebHID. */

export interface EnvInfo {
  ua: string;
  os: 'android' | 'ios' | 'windows' | 'mac' | 'linux' | 'chromeos' | 'outro';
  browser: string;
  chromeMajor: number | null;
  secure: boolean;
  protocol: string;
  hasUsb: boolean;
  hasHid: boolean;
  hasGetUserMedia: boolean;
}

export function detectEnv(): EnvInfo {
  const ua = navigator.userAgent;
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] } })
    .userAgentData;
  const plat = (uaData?.platform || navigator.platform || '').toLowerCase();

  let os: EnvInfo['os'] = 'outro';
  if (/android/i.test(ua) || plat === 'android') os = 'android';
  else if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) os = 'ios';
  else if (/windows/i.test(ua) || plat.startsWith('win')) os = 'windows';
  else if (/cros/i.test(ua) || plat === 'chrome os') os = 'chromeos';
  else if (/mac/i.test(ua) || plat.startsWith('mac')) os = 'mac';
  else if (/linux/i.test(ua)) os = 'linux';

  let browser = 'desconhecido';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/opr\//i.test(ua)) browser = 'Opera';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/crios/i.test(ua)) browser = 'Chrome (iOS)';
  else if (/chrome|chromium/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua)) browser = 'Safari';

  const m = ua.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/);
  return {
    ua,
    os,
    browser,
    chromeMajor: m ? parseInt(m[1], 10) : null,
    secure: window.isSecureContext,
    protocol: location.protocol,
    hasUsb: 'usb' in navigator && !!navigator.usb,
    hasHid: 'hid' in navigator && !!(navigator as Navigator).hid,
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
  };
}

export const OS_NAMES: Record<EnvInfo['os'], string> = {
  android: 'Android',
  ios: 'iOS/iPadOS',
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  outro: 'outro',
};

export function envSummary(e: EnvInfo): string {
  return [
    `Sistema: ${OS_NAMES[e.os]} | Navegador: ${e.browser}${e.chromeMajor ? ' ' + e.chromeMajor : ''}`,
    `Contexto seguro (HTTPS): ${e.secure ? 'sim' : 'NÃO'} (${e.protocol})`,
    `WebUSB (navigator.usb): ${e.hasUsb ? 'disponível' : 'NÃO disponível'}`,
    `WebHID (navigator.hid): ${e.hasHid ? 'disponível' : 'NÃO disponível'}`,
    `getUserMedia: ${e.hasGetUserMedia ? 'disponível' : 'NÃO disponível'}`,
    `User-Agent: ${e.ua}`,
  ].join('\n');
}

/** Avisos em português para mostrar na tela. */
export function envWarnings(e: EnvInfo): { level: 'error' | 'warn' | 'info'; text: string }[] {
  const w: { level: 'error' | 'warn' | 'info'; text: string }[] = [];
  if (!e.secure) {
    w.push({
      level: 'error',
      text: 'A página não está em HTTPS. WebUSB e WebHID só funcionam em contexto seguro (https:// ou localhost). Abra pelo endereço https:// do GitHub Pages.',
    });
  }
  if (e.os === 'ios') {
    w.push({
      level: 'warn',
      text: 'iPhone/iPad não têm WebUSB nem WebHID (nenhum navegador no iOS tem, pois todos usam o motor do Safari). Aqui o app vai funcionar só no modo biblioteca/setlist, sem conexão com a pedaleira.',
    });
  } else if (!e.hasUsb && !e.hasHid) {
    w.push({
      level: 'error',
      text: `Este navegador (${e.browser}) não tem WebUSB nem WebHID. Use o Google Chrome (Android ou Windows) ou o Microsoft Edge (Windows).`,
    });
  }
  if (e.os === 'android' && !e.hasHid) {
    w.push({
      level: 'warn',
      text: 'Este Chrome do Android não tem WebHID. A interface de controle da GE200 é HID, e o Chrome bloqueia interfaces HID pelo WebUSB ("protected class"). O teste WebUSB abaixo vai mostrar exatamente o erro — cole o log para mim.',
    });
  }
  if (e.os === 'windows' && e.hasHid) {
    w.push({
      level: 'info',
      text: 'No Windows, use o botão "Conectar via WebHID": ele usa o driver HID que já vem no Windows, sem precisar de administrador nem de WinUSB.',
    });
  }
  return w;
}
