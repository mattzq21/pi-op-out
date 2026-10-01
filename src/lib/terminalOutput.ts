export const TERMINAL_OUTPUT_LIMIT = 4 * 1024 * 1024;

export function appendTerminalOutput(output: string, outputEnd: number, data: string, dataLength = data.length) {
  return { output: (data.length >= TERMINAL_OUTPUT_LIMIT ? data : output + data).slice(-TERMINAL_OUTPUT_LIMIT), outputEnd: outputEnd + dataLength };
}
