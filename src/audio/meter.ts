/**
 * Captura de áudio (getUserMedia) e medição de loudness em tempo real.
 * Cadeia: entrada → K-weighting (passa-altas 38 Hz + prateleira +4 dB em 1,68 kHz) → worklet que soma
 * a energia de cada bloco de 100 ms. O pico é medido no sinal sem filtro.
 * Os filtros do Web Audio aproximam os da BS.1770: os valores servem para COMPARAR presets entre si.
 */

const WORKLET = `
class GeMeter extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.acc = 0; this.peak = 0; this.size = Math.round(sampleRate * 0.1); this.chs = 0; }
  process(inputs) {
    const k = inputs[0] || [], r = inputs[1] || [];
    const len = (k[0] && k[0].length) || (r[0] && r[0].length) || 128;
    for (let c = 0; c < Math.min(k.length, 2); c++) { const x = k[c]; for (let i = 0; i < x.length; i++) this.acc += x[i] * x[i]; }
    for (let c = 0; c < r.length; c++) { const x = r[c]; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > this.peak) this.peak = a; } }
    this.chs = Math.max(this.chs, k.length);
    this.n += len;
    if (this.n >= this.size) {
      this.port.postMessage({ e: this.acc / this.n, peak: this.peak, chs: this.chs });
      this.n = 0; this.acc = 0; this.peak = 0; this.chs = 0;
    }
    return true;
  }
}
registerProcessor('ge-meter', GeMeter);
`;

export interface InputInfo {
  deviceId: string;
  label: string;
}

export interface BlockInfo {
  /** Energia K-weighted do bloco de 100 ms (soma dos canais). */
  e: number;
  /** Pico absoluto (0..1) sem filtro. */
  peak: number;
  chs: number;
}

export class AudioMeter {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  readonly blocks: BlockInfo[] = [];
  onBlock: ((b: BlockInfo) => void) | null = null;
  trackInfo = '';

  get running(): boolean {
    return !!this.node;
  }

  static async listInputs(): Promise<InputInfo[]> {
    const ds = await navigator.mediaDevices.enumerateDevices();
    return ds.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || '(sem nome — permita o áudio)' }));
  }

  /** Pede permissão (necessário para os nomes das entradas aparecerem). */
  static async requestPermission(): Promise<void> {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  }

  async start(deviceId?: string): Promise<void> {
    await this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const src = ctx.createMediaStreamSource(stream);
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 38.135, Q: 0.5003 });
    const hs = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 1681.97, gain: 4.0 });
    const node = new AudioWorkletNode(ctx, 'ge-meter', { numberOfInputs: 2, numberOfOutputs: 0 });
    src.connect(hp).connect(hs).connect(node, 0, 0);
    src.connect(node, 0, 1);
    node.port.onmessage = (ev) => {
      const b = ev.data as BlockInfo;
      this.blocks.push(b);
      if (this.blocks.length > 6000) this.blocks.splice(0, 3000);
      this.onBlock?.(b);
    };
    const t = stream.getAudioTracks()[0];
    const st = t?.getSettings() ?? {};
    this.trackInfo = `"${t?.label ?? '?'}" · ${ctx.sampleRate} Hz · canais ${st.channelCount ?? '?'} · ` +
      `AGC ${st.autoGainControl ?? '?'} · eco ${st.echoCancellation ?? '?'} · ruído ${st.noiseSuppression ?? '?'}`;
    this.ctx = ctx;
    this.stream = stream;
    this.node = node;
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }

  /** Índice do próximo bloco (para marcar o início de uma medição). */
  mark(): number {
    return this.blocks.length;
  }

  energiesSince(mark: number): number[] {
    return this.blocks.slice(mark).map((b) => b.e);
  }

  peakSince(mark: number): number {
    return this.blocks.slice(mark).reduce((p, b) => Math.max(p, b.peak), 0);
  }
}
