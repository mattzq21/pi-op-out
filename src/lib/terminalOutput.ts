export const TERMINAL_OUTPUT_LIMIT = 1024 * 1024;

export function appendTerminalOutput(output: string, outputEnd: number, data: string, dataLength = data.length) {
  // ponytail: keep only enough history to restore a terminal; raise the fixed ceiling if real sessions need more scrollback.
  return { output: (output + data).slice(-TERMINAL_OUTPUT_LIMIT), outputEnd: outputEnd + dataLength };
}
