export type SequenceStep = { sequence: string; step: number; agent: string; visible: boolean };

const marker = /^<!-- pi-desktop-sequence:(.*?) -->\n?/;

export function parseSequencePrompt(text: string): { step?: SequenceStep; text: string } {
  const match = text.match(marker); if (!match) return { text };
  try { return { step: JSON.parse(decodeURIComponent(match[1])) as SequenceStep, text: text.slice(match[0].length) }; }
  catch { return { text }; }
}
