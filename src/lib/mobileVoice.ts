import { remoteClient } from "./remoteClient";
let generation = 0;
let peer: RTCPeerConnection | undefined;
let microphone: MediaStream | undefined;
let speaker: HTMLAudioElement | undefined;
let unlisten: (() => void) | undefined;
export function closeMobileVoice() {
  generation++;
  unlisten?.(); unlisten = undefined;
  microphone?.getTracks().forEach((track) => track.stop()); microphone = undefined;
  peer?.close(); peer = undefined;
  if (speaker) { speaker.pause(); speaker.srcObject = null; speaker = undefined; }
}
async function waitForIce(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); connection.removeEventListener("icegatheringstatechange", changed); };
    const changed = () => { if (connection.iceGatheringState === "complete") { cleanup(); resolve(); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Microphone connection timed out")); }, 15000);
    connection.addEventListener("icegatheringstatechange", changed);
    changed();
  });
}
async function start(args: Record<string, unknown>) {
  closeMobileVoice();
  const version = generation;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (version !== generation) { stream.getTracks().forEach((track) => track.stop()); throw new Error("Voice call was cancelled"); }
    microphone = stream;
    const connection = new RTCPeerConnection(); peer = connection;
    speaker = new Audio(); speaker.autoplay = true;
    connection.ontrack = ({ streams }) => { if (speaker) { speaker.srcObject = streams[0]; void speaker.play().catch(() => undefined); } };
    microphone.getTracks().forEach((track) => connection.addTrack(track, microphone!));
    // Keep the WebRTC data channel in the offer, matching the native voice transport.
    connection.createDataChannel("oai-events");
    unlisten = await remoteClient.listen<{ callId: string; event: { type: string } }>("pi://voice", ({ payload }) => {
      if (payload.callId === args.callId && payload.event.type === "ended") closeMobileVoice();
    });
    await connection.setLocalDescription(await connection.createOffer());
    await waitForIce(connection);
    const answer = await remoteClient.invoke<string>("mobile_voice_start", { ...args, offer: connection.localDescription?.sdp });
    if (version !== generation) throw new Error("Voice call was cancelled");
    await connection.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (error) {
    if (version === generation) closeMobileVoice();
    void remoteClient.invoke("voice_stop", { callId: args.callId, runtimeId: args.runtimeId }).catch(() => undefined);
    throw error;
  }
}
export async function mobileVoice(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (command === "voice_start") return start(args);
  if (command === "voice_stop") closeMobileVoice();
  if (command === "voice_mute") microphone?.getAudioTracks().forEach((track) => { track.enabled = !args.muted; });
  if (command === "voice_suppress" && speaker) speaker.muted = Boolean(args.suppressed);
  return remoteClient.invoke(command, args);
}
