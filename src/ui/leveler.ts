/**
 * Fase 5 (experimental): nivelador de volume.
 *
 * 1. Captura a saída da GE200 (entrada de áudio USB) ou o microfone (modo manual).
 * 2. Para cada preset escolhido: o app troca para ele, conta 3-2-1, e você toca o trecho de referência.
 *    Mede a loudness integrada (LUFS aproximado, K-weighting + gate).
 * 3. Sugere o Preset Volume de cada um para igualar (com +dB opcional para solos).
 * 4. Aplica com 83 (buffer, sem salvar), um preset por vez. Você salva na pedaleira; o app detecta
 *    a gravação (A9) e passa para o próximo. Backup da sessão é obrigatório.
 */

import { decodeSavedPreset } from '../protocol/blocks';
import { loadPresetToBuffer } from '../protocol/commands';
import { AudioMeter, type InputInfo } from '../audio/meter';
import { estimateK, integratedLufs, recentLufs, suggest, type Measurement, type Suggestion, type TargetMode } from '../audio/loudness';
import { errText } from '../usb/explain';
import type { Log } from './log';
import type { Reader } from './reader';
import type { Editor } from './editor';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (i: number) => String(i + 1).padStart(3, '0');
const fmt = (l: number) => (Number.isFinite(l) ? l.toFixed(1) : '—');
const LS = 'ge200-web:nivelador';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Item { idx: number; solo: boolean }
interface KPair { idx: number; v1: number; l1: number; v2: number; l2: number; k: number }

interface Saved {
  items: Item[];
  measurements: Measurement[];
  kPairs: KPair[];
  kManual: number | null;
  duration: number;
  mode: TargetMode;
  soloDb: number;
  refIdx: number | null;
  deviceId: string | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'measuring'; idx: number; step: 'preparar' | 'tocar'; left: number }
  | { kind: 'applying'; idx: number; vol: number; queue: Suggestion[] };

export class Leveler {
  private meter = new AudioMeter();
  private inputs: InputInfo[] = [];
  private s: Saved = {
    items: [], measurements: [], kPairs: [], kManual: null, duration: 8, mode: 'sem-passar-100', soloDb: 2.5, refIdx: null, deviceId: null,
  };
  private phase: Phase = { kind: 'idle' };
  private cancel = false;
  private live = { m: -Infinity, st: -Infinity, peak: 0 };
  private lastLive = 0;

  constructor(private root: HTMLElement, private reader: Reader, private editor: Editor, private log: Log) {
    try {
      const t = localStorage.getItem(LS);
      if (t) this.s = { ...this.s, ...JSON.parse(t) };
    } catch {
      /* sem armazenamento */
    }
    this.meter.onBlock = () => {
      const e = this.meter.blocks.map((b) => b.e);
      this.live = {
        m: recentLufs(e, 4),
        st: recentLufs(e, 30),
        peak: Math.max(...this.meter.blocks.slice(-10).map((b) => b.peak), 0),
      };
      const now = performance.now();
      if (now - this.lastLive > 150) {
        this.lastLive = now;
        this.paintMeter();
      }
    };
    reader.onChange(() => this.render());
    this.render();
  }

  private persist(): void {
    try {
      localStorage.setItem(LS, JSON.stringify(this.s));
    } catch {
      /* ok */
    }
  }

  private get st() { return this.reader.state; }

  private k(): number {
    if (this.s.kManual) return this.s.kManual;
    const ks = this.s.kPairs.map((p) => p.k).filter((k) => k > 0.2 && k < 3).sort((a, b) => a - b);
    return ks.length ? ks[ks.length >> 1] : 1;
  }

  private volumeOf(idx: number): number | null {
    const st = this.st;
    if (idx === st.activeIdx && st.editBuffer) return st.editBuffer.volume;
    return st.presets[idx]?.volume ?? null;
  }

  // ---------- áudio ----------

  async enableAudio(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.log.error('getUserMedia não existe neste navegador: não dá para medir áudio aqui.');
      return;
    }
    try {
      await AudioMeter.requestPermission();
      this.inputs = await AudioMeter.listInputs();
      this.log.info('Entradas de áudio:\n' + this.inputs.map((d, i) => `  ${i + 1}. ${d.label}`).join('\n'));
      const ge = this.inputs.find((d) => /ge\s*-?200|mooer/i.test(d.label));
      if (ge) this.log.ok(`A GE200 aparece como entrada de áudio: "${ge.label}".`);
      else this.log.warn('A GE200 NÃO aparece como entrada de áudio. Use o microfone (modo manual) e mantenha o celular/PC na mesma posição durante todas as medições.');
      const chosen = this.inputs.find((d) => d.deviceId === this.s.deviceId) ?? ge ?? this.inputs[0];
      await this.startInput(chosen?.deviceId);
    } catch (e) {
      this.log.error('Áudio: ' + errText(e));
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        this.log.warn('O navegador (ou a política da empresa) negou o acesso ao áudio. Libere o microfone para este site no cadeado da barra de endereço.');
      }
    }
    this.render();
  }

  private async startInput(deviceId?: string): Promise<void> {
    await this.meter.start(deviceId);
    this.s.deviceId = deviceId ?? null;
    this.persist();
    this.log.ok('Medidor ligado: ' + this.meter.trackInfo);
  }

  private paintMeter(): void {
    const el = this.root.querySelector<HTMLElement>('#lv-meter');
    if (!el) return;
    const pct = (l: number) => (Number.isFinite(l) ? Math.max(0, Math.min(100, ((l + 60) / 60) * 100)) : 0);
    const peakDb = this.live.peak > 0 ? 20 * Math.log10(this.live.peak) : -Infinity;
    el.innerHTML = `
      <div class="mrow"><span>Momentâneo</span><div class="mbar"><div style="width:${pct(this.live.m)}%"></div></div><b>${fmt(this.live.m)}</b></div>
      <div class="mrow"><span>Curto (3 s)</span><div class="mbar"><div style="width:${pct(this.live.st)}%"></div></div><b>${fmt(this.live.st)}</b></div>
      <div class="mrow"><span>Pico</span><div class="mbar peak"><div style="width:${pct(peakDb)}%"></div></div><b class="${peakDb > -1 ? 'clip' : ''}">${fmt(peakDb)} dBFS</b></div>
      ${peakDb > -1 ? '<p class="warn-box error">Saturando! Abaixe o nível de gravação USB / o volume de entrada, senão a medição fica errada.</p>' : ''}`;
    const big = this.root.querySelector<HTMLElement>('#lv-big');
    if (big && this.phase.kind === 'measuring' && this.phase.step === 'tocar') big.dataset.live = fmt(this.live.m);
  }

  // ---------- presets ----------

  addItem(idx: number): void {
    if (idx < 0 || this.s.items.some((i) => i.idx === idx)) return;
    this.s.items.push({ idx, solo: /solo|lead/i.test(this.st.presets[idx]?.name ?? '') });
    this.persist();
    this.render();
  }

  // ---------- medição ----------

  async measure(idx: number): Promise<boolean> {
    if (!this.meter.running) {
      this.log.warn('Ative o áudio primeiro.');
      return false;
    }
    if (this.st.activeIdx !== idx) {
      await this.reader.goTo(idx);
      if (this.st.activeIdx !== idx) {
        this.log.warn('Não troquei de preset (cancelado ou dry-run ligado). Medição cancelada.');
        return false;
      }
      await sleep(400);
    }
    this.cancel = false;
    for (let left = 3; left > 0; left--) {
      this.phase = { kind: 'measuring', idx, step: 'preparar', left };
      this.render();
      await sleep(1000);
      if (this.cancel) return this.abort();
    }
    const mark = this.meter.mark();
    const dur = this.s.duration;
    for (let left = dur; left > 0; left--) {
      this.phase = { kind: 'measuring', idx, step: 'tocar', left };
      this.render();
      await sleep(1000);
      if (this.cancel) return this.abort();
    }
    const blocks = this.meter.energiesSince(mark);
    const lufs = integratedLufs(blocks);
    const peak = this.meter.peakSince(mark);
    const vol = this.volumeOf(idx) ?? 0;
    const name = this.st.presets[idx]?.name ?? '';
    const solo = this.s.items.find((i) => i.idx === idx)?.solo ?? false;
    this.phase = { kind: 'idle' };
    if (!Number.isFinite(lufs)) {
      this.log.warn(`Preset ${num(idx)}: nada foi captado (silêncio). Confira a entrada de áudio.`);
      this.render();
      return false;
    }
    // remedição com outro volume → estima k
    const prev = this.s.measurements.find((m) => m.idx === idx);
    if (prev && prev.volume !== vol) {
      const k = estimateK(prev.volume, prev.lufs, vol, lufs);
      if (k !== null) {
        this.s.kPairs.push({ idx, v1: prev.volume, l1: prev.lufs, v2: vol, l2: lufs, k });
        this.log.info(`Calibração: volume ${prev.volume}→${vol} mudou a loudness em ${(lufs - prev.lufs).toFixed(1)} dB → k = ${k.toFixed(2)}.`);
        if (k < 0.3) {
          this.log.warn('O Preset Volume quase não mudou o que foi captado. Provavelmente a gravação USB é feita ANTES do volume do preset: ' +
            'neste caso meça pelo microfone (som do amplificador/fone) em vez da entrada USB.');
        }
      }
    }
    this.s.measurements = this.s.measurements.filter((m) => m.idx !== idx);
    this.s.measurements.push({ idx, name, lufs, volume: vol, solo });
    this.persist();
    this.log.ok(`Medido ${num(idx)} "${name}": ${lufs.toFixed(1)} LUFS (volume ${vol}, pico ${(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1)} dBFS, ${blocks.length / 10} s).`);
    this.render();
    return true;
  }

  private abort(): boolean {
    this.phase = { kind: 'idle' };
    this.log.info('Medição cancelada.');
    this.render();
    return false;
  }

  async measureAll(): Promise<void> {
    for (const it of this.s.items) {
      if (this.s.measurements.some((m) => m.idx === it.idx)) continue;
      const ok = await this.measure(it.idx);
      if (!ok || this.cancel) break;
      await sleep(800);
    }
  }

  // ---------- sugestões e aplicação ----------

  private suggestions() {
    const ms = this.s.measurements
      .filter((m) => this.s.items.some((i) => i.idx === m.idx))
      .map((m) => ({ ...m, solo: this.s.items.find((i) => i.idx === m.idx)!.solo }));
    return suggest(ms, { mode: this.s.mode, soloDb: this.s.soloDb, k: this.k(), refIdx: this.s.refIdx ?? undefined });
  }

  async applyAll(only?: number): Promise<void> {
    const link = this.reader.link;
    if (!link) return;
    if (!this.editor.hasBackup()) {
      this.log.warn('Exporte o backup (seção Editar, passo 1) antes de aplicar.');
      return;
    }
    const queue = this.suggestions().items.filter((s) => (only === undefined || s.idx === only) && s.suggested !== this.volumeOf(s.idx));
    if (!queue.length) {
      this.log.info('Nada para aplicar: os volumes já estão nos valores sugeridos.');
      return;
    }
    const dry = this.reader.isDryRun;
    if (!dry) {
      const ok = window.confirm(
        '⚠️ Aplicar Preset Volume em ' + queue.length + ' preset(s):\n\n' +
          queue.map((q) => `${num(q.idx)} ${q.name}: ${this.volumeOf(q.idx)} → ${q.suggested}`).join('\n') +
          '\n\nPara cada um, o app troca para o preset e envia o volume (83, sem salvar).\n' +
          'Aí VOCÊ salva na pedaleira; o app detecta a gravação e passa para o próximo.\n\nComeçar?',
      );
      if (!ok) return;
    }
    this.cancel = false;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      if (this.cancel) break;
      this.phase = { kind: 'applying', idx: q.idx, vol: q.suggested, queue: queue.slice(i + 1) };
      this.render();
      if (this.st.activeIdx !== q.idx) await this.reader.goTo(q.idx);
      if (!dry && this.st.activeIdx !== q.idx) {
        this.log.warn('Não consegui trocar de preset. Parando.');
        break;
      }
      const st = this.st;
      if (st.activeIdx === q.idx && st.editedSinceRead) {
        this.log.warn(`Preset ${num(q.idx)} tem edições ao vivo ainda não lidas: pulei (salve/troque de preset e leia de novo).`);
        continue;
      }
      const mem = st.presets[q.idx];
      if (!mem) continue;
      const bytes = mem.raw.slice();
      bytes[10] = q.suggested;
      try {
        const cmd = loadPresetToBuffer(bytes, `Nivelador: preset ${num(q.idx)} "${mem.name}" volume ${mem.volume}→${q.suggested} (83, sem salvar)`);
        const saved = link.waitFor((f) => f.cmd === 0xa9 && f.params[0] === q.idx, 15 * 60 * 1000);
        const sent = await link.sendWrite(cmd, dry);
        if (!sent) continue; // dry-run
        st.editBuffer = decodeSavedPreset(bytes);
        this.reader.render();
        this.log.info(`Preset ${num(q.idx)}: volume ${q.suggested} no buffer. Agora SALVE na pedaleira (ou toque em "Pular").`);
        const skip = new Promise<'skip'>((r) => { this.skipNow = () => r('skip'); });
        const r = await Promise.race([saved, skip]);
        this.skipNow = null;
        if (r === 'skip') {
          this.log.info(`Preset ${num(q.idx)} pulado (não salvo).`);
        } else if (r) {
          const v = r.params[1 + 10];
          this.log.add(v === q.suggested ? 'ok' : 'warn', `Preset ${num(q.idx)} salvo com volume ${v}${v === q.suggested ? '' : ` (esperado ${q.suggested})`}.`);
        }
      } catch (e) {
        this.log.error('Falha: ' + errText(e));
        break;
      }
    }
    this.phase = { kind: 'idle' };
    this.render();
    this.log.info('Nivelador: aplicação terminada. Para conferir, meça de novo os presets alterados (isso também calibra o modelo de volume).');
  }

  private skipNow: (() => void) | null = null;

  // ---------- render ----------

  render(): void {
    const st = this.st;
    const connected = !!this.reader.link;
    const all = st.presets.every(Boolean);
    const sug = this.suggestions();
    const sugBy = new Map(sug.items.map((s) => [s.idx, s]));
    const ph = this.phase;
    const busy = ph.kind !== 'idle' || this.reader.isBusy;
    const k = this.k();
    const options = st.presets
      .map((p, i) => (p && p.name !== 'EMPTY' && !this.s.items.some((it) => it.idx === i) ? `<option value="${i}">${num(i)} ${esc(p.name)}</option>` : ''))
      .join('');

    this.root.innerHTML = `
      <h2>Nivelador de volume <span class="phase-tag">Fase 5 · experimental</span></h2>
      <p class="hint">Mede o volume percebido de cada preset enquanto você toca o mesmo trecho, e sugere o Preset Volume para igualar.</p>

      <h3>1. Entrada de áudio</h3>
      ${this.meter.running ? `
        <select data-lv="input">${this.inputs.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === this.s.deviceId ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select>
        <div id="lv-meter" class="meter"></div>
        <p class="hint small">Valores em LUFS aproximados: servem para comparar presets entre si. Com o microfone, não mexa no celular/PC entre as medições.</p>`
      : `<div class="btns"><button class="big primary" data-lv="audio">Ativar áudio</button></div>`}

      <h3>2. Presets a nivelar</h3>
      ${!all ? '<p class="hint">Leia os presets primeiro (seção Leitura).</p>' : `
        <div class="btns">
          <button data-lv="addactive" ${st.activeIdx !== null && !this.s.items.some((i) => i.idx === st.activeIdx) ? '' : 'disabled'}>+ preset ativo</button>
          <select data-lv="addsel"><option value="">+ escolher preset…</option>${options}</select>
        </div>`}
      ${this.s.items.length ? `<div class="lvlist">${this.s.items.map((it) => {
        const p = st.presets[it.idx];
        const m = this.s.measurements.find((x) => x.idx === it.idx);
        const s = sugBy.get(it.idx);
        const cur = this.volumeOf(it.idx);
        const isActive = ph.kind !== 'idle' && ph.idx === it.idx;
        return `<div class="lvrow ${isActive ? 'now' : ''}">
          <div class="lvname"><b>${num(it.idx)}</b> ${esc(p?.name ?? '?')}</div>
          <div class="lvdata">
            <span>vol <b>${cur ?? '—'}</b></span>
            <span>medido <b>${m ? fmt(m.lufs) : '—'}</b>${m && m.volume !== cur ? `<small> (com vol ${m.volume})</small>` : ''}</span>
            <span>sugestão <b class="${s && s.suggested !== cur ? 'chg' : ''}">${s ? s.suggested : '—'}</b>${s?.clamped ? ' <small class="unsaved">limite</small>' : ''}</span>
            <label class="check mini"><input type="checkbox" data-solo="${it.idx}" ${it.solo ? 'checked' : ''}> solo</label>
          </div>
          <div class="lvbtns">
            <button data-measure="${it.idx}" ${busy || !this.meter.running || !connected ? 'disabled' : ''}>Medir</button>
            <button data-apply="${it.idx}" ${busy || !s || s.suggested === cur || !connected ? 'disabled' : ''}>Aplicar</button>
            <button data-remove="${it.idx}" ${busy ? 'disabled' : ''} aria-label="Remover">✕</button>
          </div>
        </div>`;
      }).join('')}</div>` : ''}

      ${ph.kind === 'measuring' ? `<div class="lvbig ${ph.step}" id="lv-big">
          ${ph.step === 'preparar' ? `Preparar… <span>${ph.left}</span>` : `TOQUE! <span>${ph.left} s</span>`}
          <div class="small">${num(ph.idx)} ${esc(st.presets[ph.idx]?.name ?? '')}</div>
          <button data-lv="cancel" class="danger-outline">Cancelar</button></div>` : ''}
      ${ph.kind === 'applying' ? `<div class="lvbig tocar">Salve na pedaleira <div class="small">${num(ph.idx)} ${esc(st.presets[ph.idx]?.name ?? '')} → volume ${ph.vol}${ph.queue.length ? ` · faltam ${ph.queue.length}` : ''}</div>
          <div class="btns"><button data-lv="skip">Pular</button><button data-lv="cancel" class="danger-outline">Parar</button></div></div>` : ''}

      ${this.s.items.length ? `<div class="btns">
        <label class="check">Duração <select data-lv="dur">${[5, 8, 12, 20].map((d) => `<option ${d === this.s.duration ? 'selected' : ''}>${d}</option>`).join('')}</select> s</label>
        <button class="big" data-lv="measureall" ${busy || !this.meter.running || !connected ? 'disabled' : ''}>Medir os que faltam</button>
      </div>` : ''}

      <h3>3. Alvo</h3>
      <div class="lvopts">
        <label class="check"><input type="radio" name="lvmode" value="sem-passar-100" ${this.s.mode === 'sem-passar-100' ? 'checked' : ''}> O mais alto possível sem nenhum passar de 100</label>
        <label class="check"><input type="radio" name="lvmode" value="mediana" ${this.s.mode === 'mediana' ? 'checked' : ''}> Mediana dos presets</label>
        <label class="check"><input type="radio" name="lvmode" value="referencia" ${this.s.mode === 'referencia' ? 'checked' : ''}> Igual a um preset de referência
          <select data-lv="ref">${this.s.measurements.map((m) => `<option value="${m.idx}" ${m.idx === this.s.refIdx ? 'selected' : ''}>${num(m.idx)} ${esc(m.name)}</option>`).join('')}</select></label>
        <label class="check">Solos: + <input type="number" min="0" max="6" step="0.5" value="${this.s.soloDb}" data-lv="solodb" class="numin"> dB</label>
        <label class="check">Modelo do volume k = <input type="number" min="0.3" max="3" step="0.05" value="${this.s.kManual ?? ''}" placeholder="${k.toFixed(2)}" data-lv="k" class="numin">
          <small>${this.s.kPairs.length ? `(medido: ${this.s.kPairs.map((p) => p.k.toFixed(2)).join(', ')})` : '(1 = suposição; remeça após aplicar para calibrar)'}</small></label>
      </div>
      ${Number.isFinite(sug.base) ? `<p class="hint">Alvo: <b>${fmt(sug.base)} LUFS</b> (presets normais)${this.s.items.some((i) => i.solo) ? `, ${fmt(sug.base + this.s.soloDb)} LUFS (solos)` : ''}.</p>` : ''}

      <h3>4. Aplicar</h3>
      ${!this.editor.hasBackup() ? '<p class="warn-box warn">Exporte o backup (seção Editar, passo 1) antes de aplicar.</p>' : ''}
      <div class="btns">
        <button class="big primary" data-lv="applyall" ${busy || !connected || !this.editor.hasBackup() || !sug.items.some((s) => s.suggested !== this.volumeOf(s.idx)) ? 'disabled' : ''}>Aplicar todas as sugestões</button>
        <button data-lv="clear" ${busy || !this.s.measurements.length ? 'disabled' : ''}>Apagar medições</button>
      </div>
      <p class="hint small">O dry-run da seção de palco também vale aqui (mostra os pacotes sem enviar).</p>
    `;
    this.bind();
    this.paintMeter();
  }

  private bind(): void {
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector<T>(s);
    const click = (s: string, fn: () => void) => { const el = q(s); if (el) el.onclick = fn; };
    click('[data-lv=audio]', () => void this.enableAudio());
    click('[data-lv=addactive]', () => this.st.activeIdx !== null && this.addItem(this.st.activeIdx));
    click('[data-lv=measureall]', () => void this.measureAll());
    click('[data-lv=applyall]', () => void this.applyAll());
    click('[data-lv=cancel]', () => { this.cancel = true; this.skipNow?.(); });
    click('[data-lv=skip]', () => this.skipNow?.());
    click('[data-lv=clear]', () => {
      if (!window.confirm('Apagar todas as medições e a calibração?')) return;
      this.s.measurements = [];
      this.s.kPairs = [];
      this.persist();
      this.render();
    });
    const input = q<HTMLSelectElement>('[data-lv=input]');
    if (input) input.onchange = () => void this.startInput(input.value).then(() => this.render()).catch((e) => this.log.error('Áudio: ' + errText(e)));
    const add = q<HTMLSelectElement>('[data-lv=addsel]');
    if (add) add.onchange = () => add.value !== '' && this.addItem(Number(add.value));
    const dur = q<HTMLSelectElement>('[data-lv=dur]');
    if (dur) dur.onchange = () => { this.s.duration = Number(dur.value); this.persist(); };
    const ref = q<HTMLSelectElement>('[data-lv=ref]');
    if (ref) ref.onchange = () => { this.s.refIdx = Number(ref.value); this.persist(); this.render(); };
    if (ref && this.s.refIdx === null && ref.value) this.s.refIdx = Number(ref.value);
    const solo = q<HTMLInputElement>('[data-lv=solodb]');
    if (solo) solo.onchange = () => { this.s.soloDb = Math.max(0, Math.min(6, Number(solo.value) || 0)); this.persist(); this.render(); };
    const kin = q<HTMLInputElement>('[data-lv=k]');
    if (kin) kin.onchange = () => { const v = Number(kin.value); this.s.kManual = v >= 0.3 && v <= 3 ? v : null; this.persist(); this.render(); };
    this.root.querySelectorAll<HTMLInputElement>('input[name=lvmode]').forEach((r) => {
      r.onchange = () => { this.s.mode = r.value as TargetMode; this.persist(); this.render(); };
    });
    this.root.querySelectorAll<HTMLInputElement>('[data-solo]').forEach((c) => {
      c.onchange = () => {
        const it = this.s.items.find((i) => i.idx === Number(c.dataset.solo));
        if (it) it.solo = c.checked;
        this.persist();
        this.render();
      };
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-measure]').forEach((b) => { b.onclick = () => void this.measure(Number(b.dataset.measure)); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-apply]').forEach((b) => { b.onclick = () => void this.applyAll(Number(b.dataset.apply)); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.remove);
        this.s.items = this.s.items.filter((x) => x.idx !== i);
        this.persist();
        this.render();
      };
    });
  }
}
