import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceSession } from '../frontend/src/voice-session.js';
import type { VoicePlatform, VoiceState, VoiceReply } from '../frontend/src/voice-session.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(ask: (text: string, signal: AbortSignal) => Promise<VoiceReply> = async text => ({ id: 'reply', answer: text })) {
  let input!: Parameters<VoicePlatform['listen']>[0], endSpeech!: () => void;
  let state: VoiceState = { active: false, phase: 'idle', transcript: '' };
  let recording = false, speaking = false, starts = 0, calls = 0;
  const errors: string[] = [];
  const session = new VoiceSession({
    listen(callbacks) { input = callbacks; recording = true; starts++; return () => { recording = false; }; },
    speak(_text, end) { assert.equal(recording, false, 'microphone must be off during playback'); speaking = true; endSpeech = () => { speaking = false; end(); }; return () => { speaking = false; }; }
  }, (text, signal) => { calls++; return ask(text, signal); }, next => { state = next; }, message => errors.push(message), 5);
  return { session, get input() { return input; }, get state() { return state; }, get recording() { return recording; }, get speaking() { return speaking; }, get starts() { return starts; }, get calls() { return calls; }, get endSpeech() { return endSpeech; }, errors };
}
test('voice sends a final turn once, speaks, then automatically listens again', async () => {
  const h = setup(); h.session.start();
  h.input.text('Qual é o prazo?', true); h.input.end(); h.input.end();
  await tick(); assert.equal(h.calls, 1); assert.equal(h.state.phase, 'speaking');
  h.endSpeech(); await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(h.state.phase, 'listening'); assert.equal(h.starts, 2); h.session.stop();
});
test('interim recognition never sends unconfirmed words', async () => {
  const h = setup(); h.session.start(); h.input.text('rascunho', false);
  await new Promise(resolve => setTimeout(resolve, 12)); assert.equal(h.calls, 0); h.session.stop();
});
test('a final recognition result is sent after a pause without needing a click', async () => {
  const h = setup(); h.session.start(); h.input.text('Olá LUMINA', true);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(h.calls, 1); assert.equal(h.state.phase, 'speaking'); h.session.stop();
});
test('stopping aborts the request and discards its late answer', async () => {
  let resolve!: (reply: VoiceReply) => void, signal!: AbortSignal;
  const h = setup((_text, incoming) => { signal = incoming; return new Promise(done => { resolve = done; }); });
  h.session.start(); h.input.text('Qual o prazo?', true); h.input.end();
  h.session.stop(); assert.equal(signal.aborted, true);
  resolve({ id: 'late', answer: 'Resposta atrasada' }); await tick();
  assert.equal(h.state.active, false); assert.equal(h.speaking, false); assert.equal(h.state.phase, 'idle');
});
test('interrupting playback resumes listening and ignores old speech callbacks', async () => {
  const h = setup(); h.session.start(); h.input.text('Olá', true); h.input.end(); await tick();
  const staleEnd = h.endSpeech; h.session.interrupt(); assert.equal(h.state.phase, 'listening');
  staleEnd(); assert.equal(h.state.phase, 'listening'); assert.equal(h.recording, true); h.session.stop();
});
test('permission/network errors end the session instead of reopening the microphone', () => {
  const h = setup(); h.session.start(); const stale = h.input;
  stale.error('Permissão negada'); stale.end(); stale.text('Pergunta atrasada', true);
  assert.equal(h.state.active, false); assert.equal(h.calls, 0); assert.equal(h.recording, false); assert.deepEqual(h.errors, ['Permissão negada']); h.session.stop();
});
test('manual reading never enables the microphone', () => {
  const h = setup(); h.session.read({ id: 'manual', answer: 'Resposta' }); h.endSpeech();
  assert.equal(h.starts, 0); assert.equal(h.state.active, false); h.session.stop();
});
