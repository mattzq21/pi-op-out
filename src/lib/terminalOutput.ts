export const TERMINAL_OUTPUT_LIMIT = 1024 * 1024;

export function appendTerminalOutput(output: string, outputEnd: number, data: string, dataLength = data.length) {
  return { output: (output + data).slice(-TERMINAL_OUTPUT_LIMIT), outputEnd: outputEnd + dataLength };
}
