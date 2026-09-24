import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { AudioLines, Mic, SlidersHorizontal, Sparkles, Square, Volume2 } from 'lucide-react';
import { knownFeminineVoice, loadVoicePreferences, saveVoicePreferences, selectVoice, voiceStyles } from './voice-preferences';
import type { VoicePreferences } from './voice-preferences';
import type { VoiceReply, VoiceState } from './voice-session';
import './voice-experience.css';

type VoiceControl = VoiceState & { interrupt(): void; stop(): void; read(reply: VoiceReply): void };
export function VoiceExperience({ voice, busy }: { voice: VoiceControl; busy: boolean }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [preferences, setPreferences] = useState(loadVoicePreferences);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const update = () => setVoices(synth.getVoices().filter(item => /^pt(?:[-_]|$)/i.test(item.lang)));
    update(); synth.addEventListener('voiceschanged', update);
    return () => synth.removeEventListener('voiceschanged', update);
  }, []);
  const selectedVoice = selectVoice(voices, preferences.voiceURI);
  function update(patch: Partial<VoicePreferences>) { const next = { ...preferences, ...patch }; setPreferences(next); saveVoicePreferences(next); }
  const visible = voice.active || voice.phase === 'speaking';
  const labels = { idle: 'Pode continuar…', listening: 'Estou ouvindo você', thinking: 'Consultando suas fontes', speaking: 'Uma resposta para você' };
  return <div className="lumina-voice">
    <details className="voice-preferences"><summary><SlidersHorizontal size={14} />Voz e personalidade <span>{voiceStyles[preferences.style].label}</span></summary>
      <div className="voice-preferences-grid"><label>Voz em português<select aria-label="Voz da LUMINA" value={preferences.voiceURI} onChange={event => update({ voiceURI: event.target.value })} disabled={visible}>
        <option value="">Automática · preferência feminina</option>{preferences.voiceURI && !voices.some(item => item.voiceURI === preferences.voiceURI) && <option value={preferences.voiceURI}>Voz salva indisponível · usando automática</option>}
        {voices.map(item => <option value={item.voiceURI} key={item.voiceURI}>{item.name} · {item.lang}</option>)}
      </select></label><label>Estilo da fala<select aria-label="Estilo da fala" value={preferences.style} onChange={event => update({ style: event.target.value as VoicePreferences['style'] })} disabled={visible}>{Object.entries(voiceStyles).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label>
      <button type="button" className="button secondary" disabled={busy || visible || !window.speechSynthesis} onClick={() => voice.read({ id: 'voice-preview', answer: 'Olá, eu sou a LUMINA. Estou aqui para ajudar você a explorar o conhecimento, com clareza e cuidado. Vamos conversar?' })}><Volume2 size={15} />Ouvir amostra</button></div>
      <p>{selectedVoice ? `Voz selecionada: ${selectedVoice.name}.` : 'As vozes dependem do navegador e do sistema.'} {!selectedVoice || !knownFeminineVoice(selectedVoice) ? 'Se a automática não soar feminina, escolha outra voz e ouça a amostra.' : ''} O estilo ajusta ritmo e tom. As preferências ficam salvas neste navegador.</p>
    </details>
    {visible && <section className="voice-stage" data-phase={voice.phase} aria-label="Conversa por voz com LUMINA">
      <div className="voice-stage-heading"><span><i /> LUMINA VOICE</span><button type="button" className="voice-close" onClick={voice.stop} aria-label="Encerrar conversa por voz"><Square size={13} />Encerrar</button></div>
      <div className="voice-visual" aria-hidden="true"><div className="voice-halo" /><div className="voice-ring ring-one" /><div className="voice-ring ring-two" /><div className="voice-orb"><Sparkles size={39} /></div><div className="voice-particles">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div></div>
      <span className="voice-style-caption">{voiceStyles[preferences.style].label} · {selectedVoice?.lang ?? 'pt-BR'}</span>
      <h3 role="status" aria-live="polite">{labels[voice.phase]}</h3>
      <div className="voice-wave" aria-hidden="true">{Array.from({ length: 25 }, (_, i) => <i key={i} style={{ '--i': i, '--height': `${12 + (1 - Math.abs(i - 12) / 13) * 32}px` } as CSSProperties} />)}</div>
      <p className="voice-transcript">{voice.transcript || (voice.phase === 'speaking' ? 'Ouça com calma. Você pode interromper a qualquer momento.' : 'Fale naturalmente. Enviarei a pergunta após uma pausa.')}</p>
      <div className="voice-stage-actions">{voice.phase === 'speaking' ? <button type="button" className="button primary" onClick={voice.interrupt}><Mic size={16} />Interromper {voice.active ? 'e falar' : 'leitura'}</button> : <span><AudioLines size={15} />{voice.phase === 'thinking' ? 'Microfone pausado durante a consulta' : 'A conversa continua no seu ritmo'}</span>}</div>
    </section>}
  </div>;
}
