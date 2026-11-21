/**
 * Painel da Fase 4: backup, edição dos blocos do preset ativo e Preset Volume.
 *
 * Regras de segurança:
 *  - Edição de blocos (90..97) só muda o buffer de edição: nada é salvo na memória.
 *    A 1ª edição da sessão pede confirmação. Dry-run (da seção de palco) vale aqui também.
 *  - Preset Volume usa 83 (carregar preset no buffer, sem salvar) e SEMPRE pede confirmação,
 *    e só funciona depois de um backup feito a partir da leitura atual.
 *  - Salvar na memória (A8) NÃO é enviado pelo app: o usuário salva no botão da pedaleira.
 */

import { BLOCKS, decodeLiveBlock, decodeSavedPreset, type BlockDef, type BlockState } from '../protocol/blocks';
import { BLOCK_MENU, EXPERIMENTAL_BLOCKS, loadPresetToBuffer, menuSwitch, setBlock, type WriteCommand } from '../protocol/commands';
import { diffPresets, hexToBytes, makeBackup, offsetName, parseBackup, toMo, type Backup, type PresetDiff } from '../protocol/backup';
import { AMP_MODEL_NAMES, CAB_MODEL_NAMES } from '../protocol/constants';
import { ascii, hex } from '../protocol/frame';
import { errText } from '../usb/explain';
import { downloadText, type Log } from './log';
import type { Reader } from './reader';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (i: number) => String(i + 1).padStart(3, '0');
const LS_KEY = 'ge200-web:ultimo-backup';

const MICS = ['SM57', 'U47', 'U87', 'NT1', 'MD421', 'MD441', 'MXL2001', 'MXL2003', 'C3000', 'C4000B'];
const TUBES = ['Off', 'EL34', 'EL84', '6L6', '6V6'];

interface FieldUi { max: number; options?: string[] }

/** Campos editáveis (faixas tiradas da interface do MooerManager). O resto fica só leitura. */
const EDITABLE: Record<string, Record<string, FieldUi>> = {
  fx: { p1: { max: 100 }, p2: { max: 100 }, p3: { max: 100 }, level: { max: 100 } },
  ds: { volume: { max: 100 }, tone: { max: 100 }, gain: { max: 100 } },
  amp: { gain: { max: 100 }, bass: { max: 100 }, mid: { max: 100 }, treble: { max: 100 }, pres: { max: 100 }, mst: { max: 100 } },
  cab: { mic: { max: 9, options: MICS }, center: { max: 100 }, distance: { max: 100 }, tube: { max: 4, options: TUBES } },
  ns: { attack: { max: 100 }, release: { max: 100 }, thresh: { max: 99 } },
  eq: { band1: { max: 24 }, band2: { max: 24 }, band3: { max: 24 }, band4: { max: 24 } },
  mod: { rate: { max: 99 }, level: { max: 99 }, depth: { max: 99 } },
  // experimentais (máximos a confirmar no display da pedaleira)
  dly: { level: { max: 100 }, feedback: { max: 100 }, time: { max: 2000 } },
  rvb: { preDelay: { max: 100 }, level: { max: 100 }, decay: { max: 100 }, tone: { max: 100 } },
};

function userNames(hexStr: string | undefined): string[] {
  if (!hexStr) return [];
  const b = hexToBytes(hexStr);
  return Array.from({ length: 10 }, (_, i) => ascii(b.subarray(15 * i, 15 * i + 15)).trim());
}

function save(name: string, bytes: Uint8Array): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export class Editor {
  private armedEdit = false;
  private armedExperimental = false;
  private interacting = false;
  private queue: Promise<void> = Promise.resolve();
  private lastBackup: Backup | null = null;
  /** readGen da leitura salva no 1º backup desta sessão (-1 = nenhum). O backup é o ponto de restauração da sessão. */
  private backupGen = -1;
  private volTarget: number | null = null;
  private volKey = '';
  private volSent: { idx: number; vol: number } | null = null;
  private diff: { title: string; items: PresetDiff[] } | null = null;
  private verifying = false;

  constructor(private root: HTMLElement, private reader: Reader, private log: Log, private appVersion: string) {
    try {
      const t = localStorage.getItem(LS_KEY);
      if (t) this.lastBackup = parseBackup(t);
    } catch {
      /* sem armazenamento: tudo bem */
    }
    reader.onChange(() => {
      if (!this.interacting) this.render();
    });
    this.render();
  }

  private get st() { return this.reader.state; }

  private allPresets(): boolean {
    return this.st.presets.every(Boolean);
  }

  private hasBackupNow(): boolean {
    return this.backupGen >= 1;
  }

  // ---------- backup ----------

  exportBackup(): void {
    const st = this.st;
    if (!this.allPresets()) return;
    const extras: Record<string, string> = {};
    for (const [k, v] of st.other) extras['0x' + k.toString(16).toUpperCase()] = v;
    const b = makeBackup({
      appVersion: this.appVersion,
      device: st.identity,
      activeIdx: st.activeIdx,
      presets: st.presets.map((p) => ({ name: p!.name, volume: p!.volume, raw: p!.raw })),
      extras,
    });
    const stamp = b.date.slice(0, 16).replace(/[-:T]/g, '');
    downloadText(`ge200-backup-${stamp}.json`, JSON.stringify(b, null, 1));
    this.lastBackup = b;
    this.backupGen = st.readGen;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(b));
    } catch {
      this.log.warn('Não consegui guardar uma cópia do backup no navegador (o arquivo foi baixado normalmente).');
    }
    this.log.ok(`Backup exportado: 200 presets (${b.date}). Guarde o arquivo .json.`);
    this.render();
  }

  exportMo(): void {
    const st = this.st;
    if (st.activeIdx === null) return;
    const p = st.editBuffer ?? st.presets[st.activeIdx];
    if (!p) return;
    save(`${num(st.activeIdx)} ${p.name || 'preset'}.mo`, toMo(p.raw));
    this.log.info(`Preset ${num(st.activeIdx)} exportado como .mo.`);
  }

  compare(b: Backup, title: string): void {
    const now = this.st.presets;
    if (!now.every(Boolean)) {
      this.log.warn('Leia os presets antes de comparar.');
      return;
    }
    const before = b.presets.map((p) => hexToBytes(p.hex));
    const after = now.map((p) => p!.raw);
    this.diff = { title, items: diffPresets(before, after, now.map((p) => p!.name)) };
    const n = this.diff.items.length;
    this.log.info(`${title}: ${n === 0 ? 'nenhum preset mudou' : `${n} preset(s) diferentes`}` +
      this.diff.items.slice(0, 20).map((d) => `\n  ${num(d.index)} ${d.name}: ` +
        this.describeChanges(d.changes)).join(''));
    this.render();
  }

  async loadBackupFile(file: File): Promise<void> {
    try {
      const b = parseBackup(await file.text());
      this.compare(b, `Comparação com ${file.name}`);
    } catch (e) {
      this.log.error('Backup inválido: ' + errText(e));
    }
  }

  // ---------- escrita ----------

  private async send(cmd: WriteCommand): Promise<boolean> {
    const link = this.reader.link;
    if (!link) return false;
    return link.sendWrite(cmd, this.reader.isDryRun);
  }

  private confirmEdit(cmd: WriteCommand, experimental: boolean): boolean {
    if (this.reader.isDryRun) return true;
    if (experimental && !this.armedExperimental) {
      const ok = window.confirm(
        '⚠️ EXPERIMENTAL — DELAY/REVERB\n\n' +
          `${cmd.label}\n${hex(cmd.frame)}\n\n` +
          'O MooerManager nunca enviou este comando. O formato é o mesmo que a própria pedaleira manda, mas não foi testado. ' +
          'O tipo do efeito não muda; só o parâmetro. Nada é salvo na memória.\n\n' +
          'Se a pedaleira reagir de forma estranha (travar, som errado), desligue e ligue de novo: sem salvar, nada se perde.\n\n' +
          'Se confirmar, as próximas edições de DELAY/REVERB nesta sessão vão direto.\n\nEnviar?',
      );
      if (!ok) {
        this.log.warn('Usuário cancelou a edição experimental.');
        return false;
      }
      this.armedExperimental = true;
      this.armedEdit = true;
      this.log.ok('Usuário liberou edições experimentais de DELAY/REVERB nesta sessão.');
      return true;
    }
    if (this.armedEdit) return true;
    const ok = window.confirm(
      'O app vai enviar uma EDIÇÃO DE PARÂMETRO para a pedaleira:\n\n' +
        `${cmd.label}\n${hex(cmd.frame)}\n\n` +
        'Isto muda o som do preset ativo na hora (buffer de edição), mas NÃO salva na memória. ' +
        'Se você trocar de preset sem salvar na pedaleira, a edição se perde.\n\n' +
        'Se confirmar, as próximas edições nesta sessão vão direto (dá para bloquear de novo).\n\nEnviar?',
    );
    if (ok) {
      this.armedEdit = true;
      this.log.ok('Usuário liberou edições de parâmetros nesta sessão.');
    } else {
      this.log.warn('Usuário cancelou a edição.');
    }
    return ok;
  }

  /** Enfileira a edição de um bloco (envia na ordem, um de cada vez). */
  editBlock(def: BlockDef, mutate: (raw: Uint8Array) => void, what: string): void {
    const cur = this.st.live.get(def.key);
    if (!cur?.raw) return;
    const raw = cur.raw.slice();
    mutate(raw);
    let cmd: WriteCommand;
    try {
      cmd = setBlock(def.cmd, raw, `${def.label}: ${what}`, cur.raw);
    } catch (e) {
      this.log.error('Edição recusada: ' + errText(e));
      this.render();
      return;
    }
    if (!this.confirmEdit(cmd, EXPERIMENTAL_BLOCKS.has(def.cmd))) {
      this.render();
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        const menu = BLOCK_MENU[def.cmd];
        if (this.st.menu !== menu) {
          if (await this.send(menuSwitch(menu))) this.st.menu = menu;
        }
        if (await this.send(cmd)) {
          const b = decodeLiveBlock(def.cmd, raw);
          if (b) this.st.live.set(def.key, b);
          this.st.editedSinceRead = true;
        }
      } catch (e) {
        this.log.error('Falha ao enviar: ' + errText(e));
      }
      this.reader.render();
    });
  }

  /** Diferenças entre o buffer de edição (86) e a memória (A5) do preset ativo. */
  private unsavedChanges(): PresetDiff['changes'] {
    const st = this.st;
    const mem = st.activeIdx !== null ? st.presets[st.activeIdx] : null;
    if (!st.editBuffer || !mem) return [];
    return diffPresets([mem.raw], [st.editBuffer.raw], ['']).flatMap((d) => d.changes);
  }

  private describeChanges(ch: PresetDiff['changes']): string {
    // junta bytes do mesmo campo (ex.: DELAY time = 2 bytes)
    const seen = new Map<string, string>();
    for (const c of ch) {
      const n = offsetName(c.offset);
      if (!seen.has(n)) seen.set(n, `${n} ${c.before}→${c.after}`);
    }
    return [...seen.values()].join(', ');
  }

  async sendVolume(): Promise<void> {
    const st = this.st;
    const idx = st.activeIdx;
    const target = this.volTarget;
    if (idx === null || target === null) return;
    const base = st.editBuffer ?? st.presets[idx];
    if (!base) return;
    if (!this.hasBackupNow()) {
      this.log.warn('Exporte o backup antes de mudar o volume.');
      return;
    }
    const bytes = base.raw.slice();
    const before = bytes[10];
    bytes[10] = target;
    let cmd: WriteCommand;
    try {
      cmd = loadPresetToBuffer(bytes, `Preset Volume ${before}→${target} no preset ativo ${num(idx)} "${base.name}" (83, sem salvar)`);
    } catch (e) {
      this.log.error(errText(e));
      return;
    }
    if (!this.reader.isDryRun) {
      const ok = window.confirm(
        '⚠️ EXPERIMENTAL — Preset Volume\n\n' +
          `Preset ativo: ${num(idx)} "${base.name}"\nVolume: ${before} → ${target}\n\n` +
          'O app vai mandar o preset ativo inteiro de volta para a pedaleira (comando 83, 512 bytes), ' +
          'igual ao que ela mesma mandou, mudando só o byte do volume. Isso carrega no buffer de edição e NÃO salva.\n\n' +
          (() => {
            const other = this.unsavedChanges().filter((c) => c.offset !== 10);
            return other.length
              ? `ATENÇÃO: o preset ativo já tem alterações NÃO SALVAS na pedaleira (${this.describeChanges(other)}). ` +
                  'Elas continuam no buffer; se você salvar na pedaleira, serão gravadas junto com o volume.\n\n'
              : '';
          })() +
          'Depois confira no display. Para manter, salve na própria pedaleira.\n\nEnviar?',
      );
      if (!ok) {
        this.log.warn('Usuário cancelou o envio do volume.');
        return;
      }
    }
    try {
      if (await this.send(cmd)) {
        st.editBuffer = decodeSavedPreset(bytes);
        this.volSent = { idx, vol: target };
        this.log.ok(`Volume ${target} enviado ao buffer do preset ${num(idx)}. Confira no display da pedaleira.`);
      }
    } catch (e) {
      this.log.error('Falha ao enviar: ' + errText(e));
    }
    this.reader.render();
  }

  async verify(): Promise<void> {
    if (!this.lastBackup) return;
    this.verifying = true;
    this.render();
    try {
      await this.reader.readAll();
      if (this.allPresets()) this.compare(this.lastBackup, `Comparação com o backup de ${this.lastBackup.date.slice(0, 16).replace('T', ' ')}`);
    } finally {
      this.verifying = false;
      this.render();
    }
  }

  // ---------- render ----------

  private typeOptions(def: BlockDef): { value: number; name: string }[] {
    let names = def.types ?? [];
    if (def.key === 'amp') {
      const user = userNames(this.st.other.get(0xe3));
      names = [...AMP_MODEL_NAMES.slice(0, 55), ...user.map((u, i) => (u && u !== 'EMPTY' ? `USER ${i + 1}: ${u}` : ''))];
    } else if (def.key === 'cab') {
      const user = userNames(this.st.other.get(0x85));
      names = [...CAB_MODEL_NAMES.slice(0, 26), ...user.map((u, i) => (u && u !== 'EMPTY' ? `USER ${i + 1}: ${u}` : ''))];
    }
    return names.map((name, i) => ({ value: i + 1, name })).filter((o) => o.name);
  }

  private blockEditor(def: BlockDef, b: BlockState): string {
    const fields = EDITABLE[def.key];
    const editable = !!fields && def.cmd in BLOCK_MENU;
    const experimental = EXPERIMENTAL_BLOCKS.has(def.cmd);
    const opts = editable && !experimental ? this.typeOptions(def) : [];
    const typeOk = opts.some((o) => o.value === b.type);
    const rows = b.values.map((v, i) => {
      const f = fields?.[v.name];
      if (!editable || !f) return `<div class="frow ro"><span>${esc(v.name)}</span><span class="fval">${v.value}</span></div>`;
      if (f.options) {
        return `<div class="frow"><span>${esc(v.name)}</span><select data-b="${def.key}" data-f="${i}">${f.options
          .map((o, j) => `<option value="${j}" ${j === v.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
      }
      const max = Math.max(f.max, v.value);
      return `<div class="frow"><span>${esc(v.name)}</span><input type="range" min="0" max="${max}" value="${v.value}" data-b="${def.key}" data-f="${i}"><span class="fval" id="fv-${def.key}-${i}">${v.value}</span></div>`;
    }).join('');
    return `<div class="eblock ${b.enabled ? 'on' : 'off'}">
      <div class="bhead"><span class="bname">${esc(def.label)}${experimental ? ' <span class="exp">experimental</span>' : ''}</span>
        ${editable ? `<button class="toggle ${b.enabled ? 'on' : ''}" data-toggle="${def.key}">${b.enabled ? 'ON' : 'OFF'}</button>` : `<span class="badge">${b.enabled ? 'ON' : 'OFF'}</span>`}
      </div>
      ${editable && experimental
        ? `<div class="btype">${esc(b.typeName)}</div><p class="hint small">Tipo fixo por enquanto (não sei quantos tipos existem). Parâmetros e ON/OFF podem mudar.</p>`
        : editable
        ? `<select class="tsel" data-type="${def.key}" ${typeOk ? '' : 'disabled'}>${typeOk ? '' : `<option>${esc(b.typeName)}</option>`}${opts
            .map((o) => `<option value="${o.value}" ${o.value === b.type ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`
        : `<div class="btype">${esc(b.typeName)}</div><p class="hint small">Só leitura: o MooerManager nunca envia este bloco, então não sei se é seguro.</p>`}
      ${rows}
    </div>`;
  }

  render(): void {
    const st = this.st;
    const link = this.reader.link;
    const all = this.allPresets();
    const idx = st.activeIdx;
    const active = idx !== null ? st.presets[idx] : null;
    const base = st.editBuffer ?? active;
    const liveOk = BLOCKS.every((d) => st.live.get(d.key)?.raw);
    const busy = this.reader.isBusy || this.verifying;
    const backupNow = this.hasBackupNow();
    // novo preset ativo (ou dados recarregados): o alvo volta ao volume atual dele
    const volKey = base ? `${idx}:${st.readGen}` : '';
    if (volKey !== this.volKey) {
      this.volKey = volKey;
      this.volTarget = base?.volume ?? null;
    }

    this.root.innerHTML = `
      <h2>Editar <span class="phase-tag">Fase 4</span></h2>
      ${!link ? '<p class="hint">Conecte via WebHID e leia os presets para habilitar.</p>' : !all ? '<p class="hint">Leia os presets primeiro ("Ler presets e parâmetros").</p>' : ''}

      <h3>1. Backup</h3>
      <p class="hint">Obrigatório antes de mexer no volume. O arquivo .json tem os 200 presets byte a byte.</p>
      <div class="btns">
        <button class="big ${backupNow ? '' : 'primary'}" data-ed="backup" ${all && !busy ? '' : 'disabled'}>Exportar backup (JSON)</button>
        <button class="big" data-ed="mo" ${base ? '' : 'disabled'}>Exportar preset ativo (.mo)</button>
      </div>
      <p class="hint">${backupNow ? '✅ Backup feito nesta sessão.' : '⚠️ Ainda não há backup nesta sessão.'}
        ${this.lastBackup ? `Último backup guardado no navegador: ${esc(this.lastBackup.date.slice(0, 16).replace('T', ' '))} UTC.` : ''}</p>
      <div class="btns">
        <button data-ed="cmp" ${this.lastBackup && all && !busy ? '' : 'disabled'}>Comparar com o último backup</button>
        <label class="filebtn">Comparar com arquivo…<input type="file" accept=".json,application/json" data-ed="file" ${all ? '' : 'disabled'}></label>
      </div>
      ${this.diff ? `<div class="diff"><strong>${esc(this.diff.title)}:</strong> ${this.diff.items.length === 0 ? 'nenhum preset mudou.' :
        `<ul>${this.diff.items.map((d) => `<li>${num(d.index)} ${esc(d.name)}: ${esc(this.describeChanges(d.changes))}</li>`).join('')}</ul>`}</div>` : ''}

      <h3>2. Preset Volume <small>(experimental)</small></h3>
      ${!base ? '<p class="hint">—</p>' : `
        <p class="hint">Preset ativo <b>${num(idx!)} ${esc(base.name)}</b>: volume atual <b>${active?.volume ?? '—'}</b> na memória${st.editBuffer && st.editBuffer.volume !== active?.volume ? `, <b>${st.editBuffer.volume}</b> no buffer (não salvo)` : ''}.</p>
        <div class="volrow">
          <button class="vbtn" data-vol="-5">−5</button><button class="vbtn" data-vol="-1">−1</button>
          <input type="range" min="0" max="100" value="${this.volTarget ?? 0}" data-ed="volr">
          <button class="vbtn" data-vol="1">+1</button><button class="vbtn" data-vol="5">+5</button>
          <span class="volval" id="volval">${this.volTarget ?? '—'}</span>
        </div>
        ${(() => {
          const ch = this.unsavedChanges();
          return ch.length ? `<p class="warn-box warn">O preset ativo na pedaleira está <b>diferente da memória</b> (alterações não salvas): ${esc(this.describeChanges(ch))}.</p>` : '';
        })()}
        ${st.editedSinceRead ? '<p class="warn-box warn">Você editou blocos depois da última leitura. Para não desfazer essas edições, salve-as na pedaleira e toque em "Ler presets e parâmetros" antes de mudar o volume.</p>' : ''}
        ${!backupNow ? '<p class="warn-box warn">Exporte o backup (passo 1) para liberar.</p>' : ''}
        <div class="btns">
          <button class="big primary" data-ed="vol" ${link && backupNow && !st.editedSinceRead && !busy && this.volTarget !== base.volume ? '' : 'disabled'}>Enviar volume ${this.volTarget ?? ''} (sem salvar)</button>
        </div>
        ${this.volSent && this.volSent.idx === idx ? `<div class="warn-box info">
          Enviado: volume <b>${this.volSent.vol}</b> no buffer do preset ${num(idx!)}.<br>
          1) Confira no display da GE200 se o volume do preset mudou e ouça.<br>
          2) Para manter, <b>salve na própria pedaleira</b> (o app não manda o comando de salvar, por segurança).<br>
          3) Toque em <b>Verificar</b>: o app relê tudo (~17 s) e compara com o backup.
        </div>
        <div class="btns"><button class="big" data-ed="verify" ${this.lastBackup && !busy ? '' : 'disabled'}>${this.verifying ? 'Verificando…' : 'Verificar (reler e comparar)'}</button></div>` : ''}
      `}

      <h3>3. Parâmetros do preset ativo <small>(ao vivo, sem salvar)</small></h3>
      ${!all ? '' : !liveOk ? `<p class="hint">Os valores ao vivo deste preset ainda não chegaram (a pedaleira só manda ao ler tudo, e não reenvia quando troca de preset).</p>
        <div class="btns"><button class="big" data-ed="reload" ${busy ? 'disabled' : ''}>Recarregar parâmetros (~17 s)</button></div>` : `
        <p class="hint">Cada mudança vai na hora para a pedaleira (ao soltar o controle). Para manter, salve na pedaleira.
          ${this.armedEdit ? '<button data-ed="lockedit" class="danger-outline">Bloquear edição</button>' : 'A 1ª edição pede confirmação.'}</p>
        <div class="eblocks">${BLOCKS.map((d) => this.blockEditor(d, st.live.get(d.key)!)).join('')}</div>`}
    `;
    this.bind();
  }

  private bind(): void {
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s);
    const click = (s: string, fn: () => void) => { const el = q(s); if (el) el.onclick = fn; };
    click('[data-ed=backup]', () => this.exportBackup());
    click('[data-ed=mo]', () => this.exportMo());
    click('[data-ed=cmp]', () => this.lastBackup && this.compare(this.lastBackup, 'Comparação com o último backup'));
    click('[data-ed=vol]', () => void this.sendVolume());
    click('[data-ed=verify]', () => void this.verify());
    click('[data-ed=reload]', () => void this.reader.readAll());
    click('[data-ed=lockedit]', () => { this.armedEdit = false; this.log.info('Edição bloqueada de novo.'); this.render(); });
    const file = q<HTMLInputElement>('[data-ed=file]');
    if (file) file.onchange = () => { if (file.files?.[0]) void this.loadBackupFile(file.files[0]); };

    const setVol = (v: number) => {
      this.volTarget = Math.max(0, Math.min(100, v));
      const r = q<HTMLInputElement>('[data-ed=volr]');
      if (r) r.value = String(this.volTarget);
      this.render();
    };
    this.root.querySelectorAll<HTMLButtonElement>('[data-vol]').forEach((b) => {
      b.onclick = () => setVol((this.volTarget ?? 0) + Number(b.dataset.vol));
    });
    const vr = q<HTMLInputElement>('[data-ed=volr]');
    if (vr) {
      vr.oninput = () => { this.interacting = true; const o = q('#volval'); if (o) o.textContent = vr.value; };
      vr.onchange = () => { this.interacting = false; setVol(Number(vr.value)); };
    }

    const defOf = (key: string) => BLOCKS.find((d) => d.key === key)!;
    this.root.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => {
      b.onclick = () => {
        const def = defOf(b.dataset.toggle!);
        const on = !this.st.live.get(def.key)!.enabled;
        this.editBlock(def, (raw) => { raw[0] = 0; raw[1] = on ? 1 : 0; }, on ? 'ligar' : 'desligar');
      };
    });
    this.root.querySelectorAll<HTMLSelectElement>('[data-type]').forEach((s) => {
      s.onchange = () => {
        const def = defOf(s.dataset.type!);
        const t = Number(s.value);
        this.editBlock(def, (raw) => { raw[2] = t >> 8; raw[3] = t & 0xff; }, `tipo → ${s.selectedOptions[0]?.text ?? t}`);
      };
    });
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-b]').forEach((el) => {
      const def = defOf(el.dataset.b!);
      const i = Number(el.dataset.f);
      const name = def.liveFields[i];
      const commit = () => {
        this.interacting = false;
        const v = Number(el.value);
        this.editBlock(def, (raw) => { raw[4 + 2 * i] = v >> 8; raw[5 + 2 * i] = v & 0xff; }, `${name} → ${v}`);
      };
      if (el instanceof HTMLInputElement) {
        el.oninput = () => {
          this.interacting = true;
          const o = this.root.querySelector(`#fv-${def.key}-${i}`);
          if (o) o.textContent = el.value;
        };
        el.onchange = commit;
      } else {
        el.onchange = commit;
      }
    });
  }
}
