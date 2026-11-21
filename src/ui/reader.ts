/**
 * Painel da Fase 2: leitura (identificação, presets, parâmetros do preset ativo).
 * Envia apenas pedidos de LEITURA (84 identify, E0 lista de presets), e só depois
 * de o usuário confirmar na primeira vez.
 */

import { BLOCKS, decodeLiveBlock, decodeSavedPreset, PRESET_SIZE, type BlockState, type SavedPreset } from '../protocol/blocks';
import { ascii, hex, type Frame } from '../protocol/frame';
import { identifyRequest, patchListRequest } from '../protocol/requests';
import { presetChange, type WriteCommand } from '../protocol/commands';
import type { Ge200Link } from '../usb/hid-link';
import { errText } from '../usb/explain';
import { downloadText, type Log } from './log';

const NUM_PRESETS = 200;

export interface State {
  identity: { version: string; name: string } | null;
  fw: { version: string; model: string } | null;
  activeIdx: number | null;
  volume: number | null;
  editBuffer: SavedPreset | null;
  presets: (SavedPreset | null)[];
  live: Map<string, BlockState>;
  other: Map<number, string>;
  selected: number | null;
  /** Menu do display (frame 0x82). */
  menu: number | null;
  /** Blocos editados pelo app desde a última leitura (o 0x86 fica desatualizado). */
  editedSinceRead: boolean;
  /** Incrementa a cada leitura completa. */
  readGen: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (i: number) => String(i + 1).padStart(3, '0');

export class Reader {
  private _link: Ge200Link | null = null;
  private changeListeners = new Set<() => void>();
  private confirmed = false;
  private busy = false;
  private st: State = Reader.empty();
  get state(): State { return this.st; }
  get link(): Ge200Link | null { return this._link; }
  get isDryRun(): boolean { return this.dryRun; }
  get isBusy(): boolean { return this.busy || this.writing; }
  onChange(fn: () => void): void { this.changeListeners.add(fn); }
  private off: (() => void) | null = null;
  /** Escrita liberada pelo usuário nesta sessão (depois da confirmação). */
  private armed = false;
  private dryRun = false;
  private writing = false;

  constructor(private root: HTMLElement, private log: Log, private appVersion: string) {
    this.render();
  }

  private static empty(): State {
    return {
      identity: null, fw: null, activeIdx: null, volume: null, editBuffer: null,
      presets: new Array(NUM_PRESETS).fill(null), live: new Map(), other: new Map(), selected: null,
      menu: null, editedSinceRead: false, readGen: 0,
    };
  }

  attach(link: Ge200Link): void {
    this.detach();
    this._link = link;
    this.st = Reader.empty();
    this.off = link.onFrame((f) => this.onFrame(f));
    this.render();
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this._link = null;
    this.busy = false;
    this.render();
  }

  // ---------- recepção ----------

  private onFrame(f: Frame): void {
    const p = f.params;
    const st = this.st;
    switch (f.cmd) {
      case 0x10:
        if (p.length >= 17) st.identity = { version: ascii(p.subarray(1, 6)), name: ascii(p.subarray(6, 17)) };
        break;
      case 0x84:
        if (p.length >= 16) st.fw = { version: ascii(p.subarray(0, 5)), model: ascii(p.subarray(5, 16)) };
        break;
      case 0xa6:
        if (p.length >= 1) {
          // troca de preset: os blocos antigos deixam de valer (o aparelho deve mandar os novos em seguida — suposição)
          if (st.activeIdx !== null && st.activeIdx !== p[0]) {
            st.live.clear();
            st.editBuffer = null;
            st.editedSinceRead = false;
          }
          st.activeIdx = p[0];
        }
        break;
      case 0x86:
        if (p.length >= PRESET_SIZE) {
          try {
            st.editBuffer = decodeSavedPreset(p.slice(0, PRESET_SIZE));
          } catch (e) {
            this.log.error('0x86: ' + errText(e));
          }
        }
        break;
      case 0xa2:
        if (p.length >= 1) st.volume = p[0];
        break;
      case 0xa9:
        // a pedaleira salvou um preset (no próprio aparelho): idx + 512 bytes do que foi gravado
        if (p.length >= 1 + PRESET_SIZE && p[0] < NUM_PRESETS) {
          try {
            const saved = decodeSavedPreset(p.slice(1, 1 + PRESET_SIZE));
            st.presets[p[0]] = saved;
            if (p[0] === st.activeIdx) {
              st.editBuffer = saved;
              st.editedSinceRead = false;
            }
            this.log.ok(`A pedaleira gravou o preset ${num(p[0])} "${saved.name}" (volume ${saved.volume}). Lista do app atualizada.`);
          } catch (e) {
            this.log.error('A9: ' + errText(e));
          }
        }
        break;
      case 0xa8:
        if (p.length >= 1) this.log.info(`Pedaleira confirmou gravação: preset ${num(p[0])} "${ascii(p.subarray(1))}".`);
        break;
      case 0x82:
        if (p.length >= 1) st.menu = p[0];
        break;
      case 0xa5:
        if (p.length >= 1 + PRESET_SIZE && p[0] < NUM_PRESETS) {
          try {
            st.presets[p[0]] = decodeSavedPreset(p.slice(1, 1 + PRESET_SIZE));
          } catch (e) {
            this.log.error(`preset ${p[0]}: ${errText(e)}`);
          }
        } else {
          this.log.warn(`frame A5 com tamanho inesperado: ${p.length} bytes (esperado ${1 + PRESET_SIZE})`);
        }
        break;
      default: {
        const b = decodeLiveBlock(f.cmd, p);
        if (b) {
          st.live.set(b.key, b);
          // fora de uma leitura, um bloco ao vivo = alguém mexeu na pedaleira: o 0x86 ficou desatualizado
          if (!this.busy) {
            st.editedSinceRead = true;
            this.log.info(`Mudança feita na pedaleira: ${b.label} ${b.enabled ? 'ON' : 'OFF'} ${b.typeName}.`);
          }
        }
        else st.other.set(f.cmd, hex(p));
      }
    }
    this.scheduleRender();
  }

  private pending = false;
  private scheduleRender(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  // ---------- envio (somente pedidos de leitura) ----------

  private ask(frames: { label: string; bytes: Uint8Array }[]): boolean {
    if (this.confirmed) return true;
    const list = frames.map((f) => `• ${f.label}:\n  ${hex(f.bytes)}`).join('\n');
    const ok = window.confirm(
      'O app vai ENVIAR pela primeira vez um pacote para a pedaleira.\n\n' +
        'São só pedidos de LEITURA (identificação e lista de presets), os mesmos que o Mooer Studio manda ao conectar. ' +
        'Não mudam nenhum preset nem configuração.\n\n' + list + '\n\nEnviar?',
    );
    if (ok) {
      this.confirmed = true;
      this.log.ok('Usuário confirmou o envio de pedidos de leitura.');
    } else {
      this.log.warn('Usuário cancelou o envio.');
    }
    return ok;
  }

  async identify(): Promise<boolean> {
    const link = this._link;
    if (!link || this.busy) return false;
    if (!this.ask([{ label: 'Identificar (84 00 00)', bytes: identifyRequest() }])) return false;
    this.busy = true;
    this.render();
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const wait = link.waitFor((f) => f.cmd === 0x10 || f.cmd === 0x84, 2000);
        await link.send(identifyRequest(), `Identificar (tentativa ${attempt})`);
        const r = await wait;
        if (r) {
          this.log.ok(`Pedaleira respondeu à identificação com 0x${r.cmd.toString(16).toUpperCase()}.`);
          return true;
        }
        this.log.warn(`Sem resposta à identificação em 2 s (tentativa ${attempt}).`);
      }
      this.log.error('A pedaleira não respondeu à identificação. Copie o log e me mande.');
      return false;
    } catch (e) {
      this.log.error('Falha ao enviar: ' + errText(e));
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async readAll(): Promise<void> {
    const link = this._link;
    if (!link || this.busy) return;
    if (!this.ask([
      { label: 'Identificar (84 00 00)', bytes: identifyRequest() },
      { label: 'Ler presets (E0)', bytes: patchListRequest() },
    ])) return;
    if (!this.st.identity && !this.st.fw) {
      const ok = await this.identify();
      if (!ok) return;
    }
    this.busy = true;
    this.render();
    const t0 = performance.now();
    // nova leitura: zera o estado volátil para não misturar com dados antigos
    const keep = { identity: this.st.identity, fw: this.st.fw, readGen: this.st.readGen };
    this.st = { ...Reader.empty(), ...keep };
    try {
      const first = link.waitFor((f) => f.cmd === 0xa5, 4000);
      await link.send(patchListRequest(), 'Ler presets (E0)');
      if (!(await first)) {
        this.log.error(
          'Nenhum preset (A5) chegou em 4 s. Observação: o Mooer Studio manda um "flush" (pacote cru 3F 00 01 02 03 04…) ' +
            'entre a identificação e o E0. Eu NÃO mandei porque não sabemos o que ele faz. Copie o log e me mande.',
        );
        return;
      }
      // espera até ter os 200 ou ficar 3 s sem novos presets
      let last = this.count();
      let idle = 0;
      while (this.count() < NUM_PRESETS && idle < 3000) {
        await new Promise((r) => setTimeout(r, 250));
        const c = this.count();
        idle = c === last ? idle + 250 : 0;
        last = c;
      }
      // mais um pouco para pegar estado que vem depois (A6, blocos, A2…)
      await new Promise((r) => setTimeout(r, 800));
      const c = this.count();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (c === NUM_PRESETS) this.log.ok(`200 presets lidos em ${secs} s (${link.packetsRx} relatórios recebidos no total).`);
      else {
        const missing = this.st.presets.map((p, i) => (p ? -1 : i + 1)).filter((i) => i > 0);
        this.log.warn(`Recebi ${c} de 200 presets em ${secs} s. Faltando: ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? '…' : ''}`);
      }
      this.st.readGen++;
      this.log.info(this.summary());
    } catch (e) {
      this.log.error('Falha ao enviar: ' + errText(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // ---------- escrita (Fase 3) ----------

  /** Confirmação para troca de preset. */
  private confirmWrite(cmd: WriteCommand): boolean {
    if (this.dryRun) return true; // dry-run não envia nada
    if (this.armed && cmd.risk === 'volatil') return true;
    const ok = window.confirm(
      (cmd.risk === 'permanente' ? '⚠️ GRAVAÇÃO PERMANENTE na memória da pedaleira.\n\n' : '') +
        'O app vai enviar um COMANDO DE ESCRITA para a pedaleira:\n\n' +
        `${cmd.label}\n${hex(cmd.frame)}\n\n` +
        (cmd.risk === 'volatil'
          ? 'Isto só troca o preset ativo, como pisar no footswitch. Não grava nada na memória.\n\n' +
            'Se você confirmar, as próximas trocas de preset nesta sessão serão enviadas direto ' +
            '(dá para bloquear de novo no botão "Bloquear escrita").\n\nEnviar?'
          : 'Enviar?'),
    );
    if (ok && cmd.risk === 'volatil') {
      this.armed = true;
      this.log.ok('Usuário liberou comandos de troca de preset nesta sessão.');
    }
    if (!ok) this.log.warn('Usuário cancelou o comando de escrita.');
    return ok;
  }

  async goTo(idx: number): Promise<void> {
    const link = this._link;
    if (!link || this.busy || this.writing) return;
    const n = ((idx % NUM_PRESETS) + NUM_PRESETS) % NUM_PRESETS;
    let cmd: WriteCommand;
    try {
      cmd = presetChange(n);
    } catch (e) {
      this.log.error(errText(e));
      return;
    }
    if (!this.confirmWrite(cmd)) return;
    this.writing = true;
    this.render();
    try {
      const echo = link.waitFor((f) => f.cmd === 0xa6 && f.params[0] === n, 1200);
      const sent = await link.sendWrite(cmd, this.dryRun);
      if (!sent) return;
      const before = this.st.activeIdx;
      this.st.activeIdx = n;
      if (before !== n) {
        this.st.live.clear();
        this.st.editBuffer = null;
        this.st.editedSinceRead = false;
      }
      this.render();
      const r = await echo;
      this.log.add(r ? 'ok' : 'info', r
        ? `Pedaleira confirmou: preset ativo = ${num(n)}.`
        : `Sem eco A6 em 1,2 s (pode ser normal). Confira no display se foi para ${num(n)} · ${this.st.presets[n]?.name ?? ''}.`);
    } catch (e) {
      this.log.error('Falha ao enviar: ' + errText(e));
    } finally {
      this.writing = false;
      this.render();
    }
  }

  private count(): number {
    return this.st.presets.filter(Boolean).length;
  }

  private summary(): string {
    const st = this.st;
    const lines = ['Resumo da leitura:'];
    lines.push(`  Identificação: ${st.identity ? `${st.identity.name} v${st.identity.version}` : '-'} | 0x84: ${st.fw ? `${st.fw.model} v${st.fw.version}` : '-'}`);
    lines.push(`  Preset ativo: ${st.activeIdx !== null ? num(st.activeIdx) + ' ' + (st.presets[st.activeIdx]?.name ?? '') : 'não informado'}`);
    lines.push(`  Volume (A2): ${st.volume ?? 'não recebido'}`);
    lines.push(`  Blocos ao vivo recebidos: ${[...st.live.keys()].join(', ') || 'nenhum'}`);
    for (const b of st.live.values()) {
      lines.push(`    ${b.label}: ${b.enabled ? 'ON' : 'off'} ${b.typeName} | ${b.values.map((v) => `${v.name}=${v.value}`).join(' ')}`);
    }
    lines.push(`  Outros frames: ${[...st.other.keys()].map((k) => '0x' + k.toString(16).toUpperCase()).join(', ') || 'nenhum'}`);
    return lines.join('\n');
  }

  downloadDump(): void {
    const st = this.st;
    const dump = {
      app: 'ge200-web',
      appVersion: this.appVersion,
      date: new Date().toISOString(),
      identity: st.identity,
      fw: st.fw,
      activeIdx: st.activeIdx,
      volume: st.volume,
      presets: st.presets.map((p, i) => (p ? { index: i, name: p.name, hex: hex(p.raw) } : null)),
      live: [...st.live.values()],
      frames: this._link?.received ?? [],
    };
    downloadText(`ge200-dump-${Date.now()}.json`, JSON.stringify(dump, null, 1));
    this.log.info('Dump JSON baixado (presets em hex + todos os frames recebidos).');
  }

  // ---------- render ----------

  private blocksHtml(blocks: BlockState[]): string {
    return `<div class="blocks">${blocks
      .map(
        (b) => `<div class="block ${b.enabled ? 'on' : 'off'}">
          <div class="bhead"><span class="bname">${esc(b.label)}</span><span class="badge">${b.enabled ? 'ON' : 'OFF'}</span></div>
          <div class="btype">${esc(b.typeName)}</div>
          <dl>${b.values.map((v) => `<dt>${esc(v.name)}</dt><dd>${v.value}</dd>`).join('')}</dl>
        </div>`,
      )
      .join('')}</div>`;
  }

  /** Avisa outros painéis (editor) que o estado mudou. */
  notify(): void {
    for (const fn of this.changeListeners) fn();
  }

  render(): void {
    this.notify();
    const st = this.st;
    const connected = !!this._link;
    const c = this.count();
    const active = st.activeIdx !== null ? st.presets[st.activeIdx] : null;
    const liveBlocks = BLOCKS.map((d) => st.live.get(d.key)).filter(Boolean) as BlockState[];
    const sel = st.selected !== null ? st.presets[st.selected] : null;

    const prevScroll = this.root.querySelector('.plist')?.scrollTop ?? 0;
    const ready = connected && c === NUM_PRESETS && st.activeIdx !== null && !this.busy && !this.writing;
    const vol = (st.editBuffer ?? active)?.volume;
    const unsaved = !!(st.editBuffer && active && st.editBuffer.raw.some((b, i) => b !== active.raw[i]));
    this.root.innerHTML = `
      ${connected && c === NUM_PRESETS ? `
      <div class="stage">
        <div class="stage-now">
          <span class="stage-num">${st.activeIdx !== null ? num(st.activeIdx) : '—'}</span>
          <span class="stage-name">${esc(active?.name ?? '—')}</span>
          <span class="stage-vol">${vol !== undefined ? `volume ${vol}` : ''}${unsaved ? ' · <b class="unsaved">não salvo</b>' : ''}</span>
        </div>
        <div class="stage-btns">
          <button class="huge" data-act="prev" ${ready ? '' : 'disabled'} aria-label="Preset anterior">◀</button>
          <button class="huge" data-act="next" ${ready ? '' : 'disabled'} aria-label="Próximo preset">▶</button>
        </div>
        <div class="btns stage-opts">
          <label class="check"><input type="checkbox" data-act="dry" ${this.dryRun ? 'checked' : ''}> Dry-run (só mostra o pacote no log, não envia)</label>
          ${this.armed ? '<button data-act="lock" class="danger-outline">Bloquear escrita</button>' : '<span class="hint lockhint">Escrita bloqueada: a 1ª troca pede confirmação.</span>'}
        </div>
      </div>` : ''}
      <h2>Leitura <span class="phase-tag">Fase 2</span> · Troca de preset <span class="phase-tag">Fase 3</span></h2>
      <p class="hint">Para editar parâmetros e o volume, use a seção <strong>Editar</strong> abaixo.</p>
      ${connected ? '' : '<p class="hint">Conecte via WebHID acima para habilitar.</p>'}
      <div class="btns">
        <button class="big" data-act="identify" ${!connected || this.busy ? 'disabled' : ''}>Identificar</button>
        <button class="big primary" data-act="read" ${!connected || this.busy ? 'disabled' : ''}>Ler presets e parâmetros</button>
      </div>
      <div class="btns">
        <label class="check"><input type="checkbox" data-act="verbose" ${this._link?.verbose ? 'checked' : ''} ${connected ? '' : 'disabled'}> hex de todos os relatórios no log</label>
        <button data-act="dump" ${c || st.identity ? '' : 'disabled'}>Baixar dump (JSON)</button>
      </div>
      ${this.busy ? `<div class="progress"><div style="width:${(c / NUM_PRESETS) * 100}%"></div></div><p class="hint">${c} / ${NUM_PRESETS} presets…</p>` : ''}

      <dl class="kv2">
        <dt>Aparelho</dt><dd>${st.identity ? esc(`${st.identity.name} · firmware ${st.identity.version}`) : st.fw ? esc(`${st.fw.model} · ${st.fw.version}`) : '—'}</dd>
        <dt>Preset ativo</dt><dd class="big-val">${st.activeIdx !== null ? `${num(st.activeIdx)} · ${esc(active?.name ?? '')}` : '—'}</dd>
        <dt>Volume do preset</dt><dd>${vol ?? '—'}</dd>
        ${st.volume !== null ? `<dt>Volume (A2)</dt><dd>${st.volume}</dd>` : ''}
        <dt>Presets lidos</dt><dd>${c} / ${NUM_PRESETS}</dd>
      </dl>

      ${liveBlocks.length ? `<h3>Parâmetros do preset ativo (ao vivo)</h3>${this.blocksHtml(liveBlocks)}`
        : st.editBuffer ? `<h3>Parâmetros do preset ativo (buffer de edição 0x86)</h3>${this.blocksHtml(st.editBuffer.blocks)}`
        : active ? `<h3>Parâmetros do preset ativo (da memória)</h3>${this.blocksHtml(active.blocks)}` : ''}

      ${c ? `<h3>Presets <small>(numeração 001–200 = índice+1; toque para ver)</small></h3>
        <div class="plist">${st.presets
          .map((p, i) => p
            ? `<button class="pitem ${i === st.activeIdx ? 'active' : ''} ${i === st.selected ? 'sel' : ''}" data-preset="${i}"><span class="pn">${num(i)}</span> ${esc(p.name || '(sem nome)')}<span class="pv">${p.volume}</span></button>`
            : '')
          .join('')}</div>` : ''}

      ${sel ? `<h3>Preset ${num(st.selected!)} · ${esc(sel.name)} <small>(da memória, só leitura)</small></h3>
        <div class="btns"><button class="big primary" data-act="goto" ${ready && st.selected !== st.activeIdx ? '' : 'disabled'}>Ir para este preset</button></div>
        ${this.blocksHtml(sel.blocks)}
        <p class="hint">Volume: ${sel.volume} · byte 11: ${sel.flag11} · delay time: ${sel.delayTime} · ordem dos efeitos: ${sel.fxOrder.join(' ')}</p>
        <details><summary>bytes brutos (512)</summary><pre class="kv">${hex(sel.raw).replace(/((?:\S\S ){16})/g, '$1\n')}</pre></details>` : ''}
    `;

    const pl = this.root.querySelector('.plist');
    if (pl) pl.scrollTop = prevScroll;
    const on = (sel: string, fn: () => void) => {
      const el = this.root.querySelector<HTMLElement>(sel);
      if (el) el.onclick = fn;
    };
    on('[data-act=prev]', () => void this.goTo((this.st.activeIdx ?? 0) - 1));
    on('[data-act=next]', () => void this.goTo((this.st.activeIdx ?? 0) + 1));
    on('[data-act=goto]', () => this.st.selected !== null && void this.goTo(this.st.selected));
    on('[data-act=lock]', () => {
      this.armed = false;
      this.log.info('Escrita bloqueada de novo pelo usuário.');
      this.render();
    });
    const dry = this.root.querySelector<HTMLInputElement>('[data-act=dry]');
    if (dry) dry.onchange = () => {
      this.dryRun = dry.checked;
      this.log.info(`Dry-run ${this.dryRun ? 'LIGADO: nada de escrita será enviado' : 'desligado'}.`);
      this.render();
    };
    this.root.querySelector<HTMLButtonElement>('[data-act=identify]')!.onclick = () => void this.identify();
    this.root.querySelector<HTMLButtonElement>('[data-act=read]')!.onclick = () => void this.readAll();
    this.root.querySelector<HTMLButtonElement>('[data-act=dump]')!.onclick = () => this.downloadDump();
    const vb = this.root.querySelector<HTMLInputElement>('[data-act=verbose]')!;
    vb.onchange = () => {
      if (this._link) this._link.verbose = vb.checked;
    };
    this.root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.preset);
        this.st.selected = this.st.selected === i ? null : i;
        this.render();
      };
    });
  }
}
