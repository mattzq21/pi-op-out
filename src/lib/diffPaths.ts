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
  const fields = header.replace(/^diff --git\s+/, "").match(/"(?:\\.|[^"])*"|\S+/g) ?? [];
  const decoded = decodeGitPath(fields[1] ?? fields[0] ?? "");
  return decoded.replace(/^b\//, "");
}
