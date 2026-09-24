export function decodeGitPath(value: string) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const source = value.slice(1, -1); const bytes: number[] = []; const encoder = new TextEncoder();
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\\": 92, '"': 34 };
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\") { const character = String.fromCodePoint(source.codePointAt(index)!); bytes.push(...encoder.encode(character)); index += character.length - 1; continue; }
    const next = source[++index]; if (next === undefined) break;
    if (/[0-7]/.test(next)) { const octal = source.slice(index).match(/^[0-7]{1,3}/)![0]; index += octal.length - 1; bytes.push(Number.parseInt(octal, 8)); }
    else if (escapes[next] !== undefined) bytes.push(escapes[next]);
    else bytes.push(...encoder.encode(next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function displayPath(header: string) {
  const paths = header.replace(/^diff --git /, "");
  const quotedSource = /^"(?:\\.|[^"])*" /.exec(paths);
  if (quotedSource) return decodeGitPath(paths.slice(quotedSource[0].length)).replace(/^b\//, "");
  const separators = [...paths.matchAll(/ (?=b\/|"b\/)/g)].map((match) => match.index!);
  const separator = separators.find((index) => paths.slice(0, index).replace(/^a\//, "") === decodeGitPath(paths.slice(index + 1)).replace(/^b\//, "")) ?? separators[0];
  return decodeGitPath(separator === undefined ? paths : paths.slice(separator + 1)).replace(/^b\//, "");
}
