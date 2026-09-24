export const voiceStyles = {
  acolhedora: { label: 'Acolhedora', rate: .96, pitch: 1.04 },
  objetiva: { label: 'Objetiva', rate: 1.06, pitch: 1 },
  serena: { label: 'Serena', rate: .9, pitch: 1 }
};
export type VoicePreferences = { voiceURI: string; style: keyof typeof voiceStyles };
export const defaultVoicePreferences: VoicePreferences = { voiceURI: '', style: 'acolhedora' };
export function loadVoicePreferences(): VoicePreferences {
  try {
    const value = JSON.parse(localStorage.getItem('lumina:voice') ?? '{}');
    return { voiceURI: typeof value.voiceURI === 'string' ? value.voiceURI : '', style: Object.hasOwn(voiceStyles, value.style) ? value.style : 'acolhedora' };
  } catch { return { ...defaultVoicePreferences }; }
}
export function saveVoicePreferences(value: VoicePreferences) {
  try { localStorage.setItem('lumina:voice', JSON.stringify(value)); } catch { /* Preferences remain usable without browser storage. */ }
}
type VoiceDescriptor = { voiceURI: string; name: string; lang: string };
// Web Speech exposes no gender field. Prefer known names; always allow manual selection and preview.
export function knownFeminineVoice(voice: VoiceDescriptor) { return /\b(francisca|maria|helena|luciana|vit[oó]ria|raquel|joana|fernanda|thalita)\b/i.test(voice.name); }
export function selectVoice<T extends VoiceDescriptor>(voices: T[], preferred = ''): T | undefined {
  const portuguese = voices.filter(voice => /^pt(?:[-_]|$)/i.test(voice.lang));
  const explicit = portuguese.find(voice => voice.voiceURI === preferred);
  if (explicit) return explicit;
  const score = (voice: T) => (knownFeminineVoice(voice) ? 10 : 0) + (/^pt[-_]br$/i.test(voice.lang) ? 3 : 0);
  return [...portuguese].sort((a, b) => score(b) - score(a))[0];
}
