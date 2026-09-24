import { useEffect, useRef, useState } from 'react';
import { VoiceSession, browserVoicePlatform } from './voice-session';
import type { VoiceReply, VoiceState } from './voice-session';

export function useVoiceConversation(scope: string, ask: (text: string, signal: AbortSignal) => Promise<VoiceReply>, onError: (message: string) => void) {
  const [state, setState] = useState<VoiceState>({ active: false, phase: 'idle', transcript: '' });
  const callbacks = useRef({ ask, onError }); callbacks.current = { ask, onError };
  const session = useRef<VoiceSession | undefined>(undefined);
  if (!session.current) session.current = new VoiceSession(browserVoicePlatform(), (text, signal) => callbacks.current.ask(text, signal), setState, message => callbacks.current.onError(message));
  useEffect(() => { session.current?.stop(); return () => session.current?.stop(); }, [scope]);
  useEffect(() => {
    const hide = () => { if (document.hidden) session.current?.stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  return { ...state, start: () => session.current!.start(), stop: () => session.current!.stop(), interrupt: () => session.current!.interrupt(), read: (reply: VoiceReply) => session.current!.read(reply) };
}
