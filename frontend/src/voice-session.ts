import { loadVoicePreferences, selectVoice, voiceStyles } from './voice-preferences';
export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';
export type VoiceReply = { id: string; answer: string };
export type VoiceState = { active: boolean; phase: VoicePhase; transcript: string; replyId?: string };
export type VoicePlatform = {
  listen: (callbacks: { text: (text: string, final: boolean) => void; end: () => void; error: (message: string) => void }) => () => void;
  speak: (text: string, end: () => void, error: (message: string) => void) => () => void;
};

/** One turn owns recognition, request and playback. Late callbacks cannot revive a stopped session. */
export class VoiceSession {
  private state: VoiceState = { active: false, phase: 'idle', transcript: '' };
  private epoch = 0;
  private cancelInput?: () => void;
  private cancelOutput?: () => void;
  private request?: AbortController;
  private silence?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private restart?: ReturnType<typeof setTimeout>;
  private emptyTurns = 0;
  constructor(private platform: VoicePlatform, private ask: (text: string, signal: AbortSignal) => Promise<VoiceReply>, private changed: (state: VoiceState) => void, private error: (message: string) => void, private pauseMs = 1300) {}
  private publish(patch: Partial<VoiceState>) { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  private clear() {
    this.epoch++;
    clearTimeout(this.silence); clearTimeout(this.deadline); clearTimeout(this.restart);
    this.cancelInput?.(); this.cancelInput = undefined;
    this.cancelOutput?.(); this.cancelOutput = undefined;
    this.request?.abort(); this.request = undefined;
  }
  stop() { this.clear(); this.publish({ active: false, phase: 'idle', transcript: '', replyId: undefined }); }
  start() { this.stop(); this.emptyTurns = 0; this.publish({ active: true }); this.listen(); }
  interrupt() {
    if (this.state.phase !== 'speaking') return;
    const resume = this.state.active;
    this.clear(); this.publish({ phase: 'idle', replyId: undefined });
    if (resume) this.listen();
  }
  read(reply: VoiceReply) { this.clear(); this.play(reply); }
  private fail(message: string) { this.stop(); this.error(message); }
  private listen() {
    if (!this.state.active) return;
    this.clear(); const epoch = this.epoch;
    let finalText = '';
    const current = () => epoch === this.epoch && this.state.active && this.state.phase === 'listening';
    const finish = () => {
      if (!current()) return;
      if (finalText.trim().length >= 2) { void this.send(finalText.trim()); return; }
      this.clear();
      if (++this.emptyTurns >= 3) { this.fail('Não ouvi uma pergunta. Ative a voz novamente quando quiser conversar.'); return; }
      this.restart = setTimeout(() => this.listen(), 500);
    };
    this.publish({ phase: 'listening', transcript: '', replyId: undefined });
    try {
      this.cancelInput = this.platform.listen({
        text: (text, final) => {
          if (!current()) return;
          this.publish({ transcript: text }); clearTimeout(this.silence);
          if (final) { finalText = text; this.silence = setTimeout(finish, this.pauseMs); }
        },
        end: finish,
        error: message => { if (current()) this.fail(message); }
      });
      this.deadline = setTimeout(finish, 45000);
    } catch (error) { this.fail(error instanceof Error ? error.message : 'Não foi possível iniciar o microfone.'); }
  }
  private async send(text: string) {
    this.clear(); this.emptyTurns = 0;
    const epoch = this.epoch;
    this.publish({ phase: 'thinking', transcript: text });
    const request = new AbortController(); this.request = request;
    try {
      const reply = await this.ask(text, request.signal);
      if (epoch !== this.epoch || !this.state.active) return;
      this.request = undefined; this.play(reply);
    } catch (error) {
      if (epoch === this.epoch) this.fail(error instanceof Error ? error.message : 'Não foi possível responder.');
    }
  }
  private play(reply: VoiceReply) {
    const epoch = this.epoch;
    this.publish({ phase: 'speaking', replyId: reply.id });
    try {
      this.cancelOutput = this.platform.speak(reply.answer, () => {
        if (epoch !== this.epoch) return;
        this.cancelOutput = undefined;
        this.publish({ phase: 'idle', replyId: undefined });
        if (this.state.active) this.restart = setTimeout(() => this.listen(), 350);
      }, message => { if (epoch === this.epoch) this.fail(message); });
    } catch (error) { this.fail(error instanceof Error ? error.message : 'Não foi possível reproduzir a resposta.'); }
  }
}

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null;
  start(): void; abort(): void;
};
export function browserVoicePlatform(): VoicePlatform {
  return {
    listen(callbacks) {
      if (!window.isSecureContext) throw new Error('O microfone exige HTTPS para acesso pela rede. Neste endereço HTTP, use o chat por texto; a voz continua disponível no localhost deste computador.');
      const host = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
      const Constructor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
      if (!Constructor || !window.speechSynthesis) throw new Error('Conversa por voz indisponível neste navegador. Use um navegador com reconhecimento e síntese de voz, como Chrome ou Edge.');
      const recognition = new Constructor();
      recognition.lang = 'pt-BR'; recognition.continuous = true; recognition.interimResults = true;
      recognition.onresult = event => {
        const results = Array.from(event.results);
        callbacks.text(results.map(result => result[0].transcript).join(' ').trim(), results.every(result => result.isFinal));
      };
      recognition.onend = callbacks.end;
      recognition.onerror = event => {
        if (event.error === 'no-speech') return;
        const messages: Record<string, string> = {
          'not-allowed': 'Permita o microfone no navegador para iniciar a conversa.',
          'service-not-allowed': 'O serviço de reconhecimento de voz foi bloqueado pelo navegador.',
          'audio-capture': 'Nenhum microfone disponível. Confira o dispositivo de entrada.',
          network: 'O reconhecimento de voz perdeu a conexão. Tente novamente.',
          'language-not-supported': 'O reconhecimento em português não está disponível neste navegador.'
        };
        callbacks.error(messages[event.error] ?? 'O reconhecimento de voz foi interrompido. Ative a voz para tentar novamente.');
      };
      recognition.start();
      return () => { recognition.onresult = null; recognition.onend = null; recognition.onerror = null; recognition.abort(); };
    },
    speak(text, end, error) {
      if (!window.speechSynthesis) throw new Error('Leitura em voz indisponível neste navegador.');
      const synth = window.speechSynthesis;
      const clean = text.replace(/\[\d+\]/g, '').replace(/[*#`]/g, '').trim();
      const chunks = clean.match(/.{1,220}(?:\s|$)|\S{1,220}/gs) ?? [];
      const preferences = loadVoicePreferences();
      const style = voiceStyles[preferences.style];
      let voice = selectVoice(synth.getVoices(), preferences.voiceURI);
      let cancelled = false, index = 0, utterance: SpeechSynthesisUtterance | undefined;
      const keepAlive = setInterval(() => { if (!cancelled && synth.paused) synth.resume(); }, 10000);
      let readyTimer: ReturnType<typeof setTimeout> | undefined, started = false;
      const cleanupReady = () => { clearTimeout(readyTimer); clearInterval(keepAlive); synth.removeEventListener('voiceschanged', ready); };
      const ready = () => { if (cancelled || started) return; started = true; voice = selectVoice(synth.getVoices(), preferences.voiceURI); cleanupReady(); next(); };
      const next = () => {
        if (cancelled) return;
        if (index >= chunks.length) { end(); return; }
        utterance = new SpeechSynthesisUtterance(chunks[index++]);
        utterance.lang = voice?.lang ?? 'pt-BR'; utterance.rate = style.rate; utterance.pitch = style.pitch; if (voice) utterance.voice = voice;
        utterance.onend = next;
        utterance.onerror = () => { if (!cancelled) error('A reprodução de voz falhou. A resposta continua disponível no chat.'); };
        synth.speak(utterance);
      };
      synth.cancel();
      if (synth.getVoices().length) next();
      else { synth.addEventListener('voiceschanged', ready); readyTimer = setTimeout(ready, 1200); }
      return () => { cancelled = true; cleanupReady(); if (utterance) { utterance.onend = null; utterance.onerror = null; } synth.cancel(); };
    }
  };
}
