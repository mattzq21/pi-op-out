import challengeSource from "./challenge.js?raw";
import { z } from "zod";

export interface ChatGptRequirements {
  ticket: string;
  proofofwork?: { required: boolean; seed?: string; difficulty?: string };
  turnstile?: { required: boolean; dx?: string };
}

const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

const encode = (value: Array<string | number | null>) => btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), byte => String.fromCharCode(byte)).join(""));

function fingerprint(): Array<string | number | null> {
  return [screen.width + screen.height, String(new Date()), null, 1, userAgent,
    document.scripts[0]?.src ?? null, null, navigator.language, navigator.languages.join(","), 0,
    `hardwareConcurrency−${navigator.hardwareConcurrency}`, "location", "navigator", performance.now(), crypto.randomUUID(), "",
    navigator.hardwareConcurrency, performance.timeOrigin, 0, 0, 0, 0, 0, 0, 0];
}

export function chatGptPrepareToken() { return `gAAAAAC${encode(fingerprint())}`; }

function hash(input: string) {
  let value = 2166136261;

  for (let index = 0; index < input.length; index++) { value ^= input.charCodeAt(index); value = Math.imul(value, 16777619) >>> 0; }

  value ^= value >>> 16; value = Math.imul(value, 2246822507) >>> 0;
  value ^= value >>> 13; value = Math.imul(value, 3266489909) >>> 0;
  value ^= value >>> 16;

  return (value >>> 0).toString(16).padStart(8, "0");
}

async function proofOfWork(requirements: ChatGptRequirements, signal: AbortSignal) {
  const proof = requirements.proofofwork;

  if (!proof?.required) return undefined;

  if (!proof.seed || !proof.difficulty || !/^[a-f0-9]{1,8}$/i.test(proof.difficulty)) throw new Error("ChatGPT returned an unsupported verification challenge.");
  const start = performance.now(); const values = fingerprint();

  for (let attempt = 0; attempt < 500000; attempt++) {
    if (attempt % 1000 === 0) { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); }

    values[3] = attempt; values[9] = Math.round(performance.now() - start);
    const encoded = encode(values);

    if (hash(`${proof.seed}${encoded}`).slice(0, proof.difficulty.length) <= proof.difficulty) return `gAAAAAB${encoded}~S`;
  }

  throw new Error("ChatGPT verification could not be completed. Try again.");
}

function challenge(requirements: ChatGptRequirements, token: string, signal: AbortSignal): Promise<string | undefined> {
  if (!requirements.turnstile?.required) return Promise.resolve(undefined);

  if (!requirements.turnstile.dx) return Promise.reject(new Error("ChatGPT requires browser verification. Open ChatGPT and sign in, then try again."));
  const dx = requirements.turnstile.dx;
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe"); const nonce = crypto.randomUUID();
    frame.hidden = true; frame.sandbox.add("allow-scripts");
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"><script>${challengeSource}</script>`;

    const finish = (value?: string, error?: Error) => {
      clearTimeout(timer); window.removeEventListener("message", receive); signal.removeEventListener("abort", abort); frame.remove();

      if (error) reject(error); else resolve(value);
    };

    const abort = () => finish(undefined, new DOMException("Cancelled", "AbortError"));

    const receive = (event: MessageEvent) => {
      const packet = z.object({ nonce: z.string(), result: z.string().optional() }).safeParse(event.data);

      if (event.source !== frame.contentWindow || !packet.success || packet.data.nonce !== nonce) return;

      if (packet.data.result !== undefined) finish(packet.data.result);
      else finish(undefined, new Error("ChatGPT verification failed."));
    };

    const timer = setTimeout(() => finish(undefined, new Error("ChatGPT verification timed out.")), 3000);
    frame.onload = () => frame.contentWindow?.postMessage({ dx, token, nonce }, "*");
    window.addEventListener("message", receive); signal.addEventListener("abort", abort, { once: true });
    document.body.append(frame);
  });
}

export async function solveChatGptRequirements(requirements: ChatGptRequirements, token: string, signal: AbortSignal) {
  const [proof, turnstile] = await Promise.all([proofOfWork(requirements, signal), challenge(requirements, token, signal)]);
  signal.throwIfAborted();

  return { ticket: requirements.ticket, proof, turnstile };
}
