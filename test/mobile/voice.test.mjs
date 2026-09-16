import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ stdin: { contents: 'export * from "./src/lib/mobileVoice"; export {remoteClient} from "./src/lib/remoteClient";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { mobileVoice, closeMobileVoice, remoteClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const calls = [];
remoteClient.invoke = async (command, args) => { calls.push({ command, args }); return command === 'mobile_voice_start' ? 'answer-sdp' : undefined; };
function microphone(getUserMedia) { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } }); }
const track = () => ({ enabled: true, stopped: false, stop() { this.stopped = true; } });
const stream = (track) => ({ getTracks: () => [track], getAudioTracks: () => [track] });
test('permission denial never starts host audio', async () => {
  calls.length = 0; microphone(async () => { throw new Error('Permission denied'); });
  await assert.rejects(mobileVoice('voice_start', { callId: 'denied', context: '' }), /Permission denied/);
  assert.equal(calls.some(({command}) => command === 'mobile_voice_start' || command === 'voice_start'), false);
});
test('cancellation during microphone permission stops a late stream', async () => {
  let grant;
  const audio = track(); microphone(() => new Promise(resolve => { grant = resolve; }));
  const pending = mobileVoice('voice_start', { callId: 'cancelled', context: '' });
  const rejection = assert.rejects(pending, /cancelled/);
  closeMobileVoice(); grant(stream(audio)); await rejection;
  assert.equal(audio.stopped, true);
});
test('mobile voice negotiates phone media, mutes locally, and releases devices', async () => {
  const audio = track(); microphone(async () => stream(audio)); calls.length = 0;
  globalThis.Audio = class { pause() {} };
  let peer;
  globalThis.RTCPeerConnection = class {
    iceGatheringState = 'complete';
    constructor() { peer = this; }
    addTrack(value) { this.track = value; }
    createDataChannel() {}
    async createOffer() { return { type: 'offer', sdp: 'phone-offer-sdp' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    close() { this.closed = true; }
  };
  try {
    await mobileVoice('voice_start', { callId: 'phone', context: 'Project' });
    assert.deepEqual(calls[0], { command: 'mobile_voice_start', args: { callId: 'phone', context: 'Project', offer: 'phone-offer-sdp' } });
    assert.deepEqual(peer.remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
    await mobileVoice('voice_mute', { callId: 'phone', muted: true }); assert.equal(audio.enabled, false);
    await mobileVoice('voice_mute', { callId: 'phone', muted: false }); assert.equal(audio.enabled, true);
    await mobileVoice('voice_stop', { callId: 'phone' });
    assert.equal(audio.stopped, true); assert.equal(peer.closed, true);
  } finally { closeMobileVoice(); }
});
