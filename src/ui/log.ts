/** Painel de log: tudo que acontece vai para cá, e pode ser copiado. */

export type Level = 'info' | 'ok' | 'warn' | 'error' | 'rx' | 'tx' | 'data';

interface Entry {
  t: number;
  level: Level;
  msg: string;
}

const TAGS: Record<Level, string> = {
  info: 'INFO ',
  ok: 'OK   ',
  warn: 'AVISO',
  error: 'ERRO ',
  rx: 'RX   ',
  tx: 'TX   ',
  data: '     ',
};

export class Log {
  private entries: Entry[] = [];
  private t0 = performance.now();
  private header: () => string = () => '';

  constructor(private el: HTMLElement) {}

  setHeader(fn: () => string): void {
    this.header = fn;
  }

  add(level: Level, msg: string): void {
    const e = { t: performance.now() - this.t0, level, msg };
    this.entries.push(e);
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    line.textContent = this.format(e);
    const stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 30;
    this.el.appendChild(line);
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  info(m: string) { this.add('info', m); }
  ok(m: string) { this.add('ok', m); }
  warn(m: string) { this.add('warn', m); }
  error(m: string) { this.add('error', m); }
  data(m: string) { this.add('data', m); }

  clear(): void {
    this.entries = [];
    this.el.textContent = '';
    this.t0 = performance.now();
  }

  private format(e: Entry): string {
    const s = (e.t / 1000).toFixed(3).padStart(8, ' ');
    return e.msg
      .split('\n')
      .map((l, i) => (i === 0 ? `[${s}] ${TAGS[e.level]} ${l}` : `${' '.repeat(17)}${l}`))
      .join('\n');
  }

  text(): string {
    return [this.header(), '', ...this.entries.map((e) => this.format(e))].join('\n');
  }
}

/** Copia texto com fallback para navegadores sem Clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* cai no fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
