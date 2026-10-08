import { required } from "./required";

function appendPathText(bytes: number[], encoder: TextEncoder, source: string, index: number) {
  const slash = source.indexOf("\\", index);
  const end = slash < 0 ? source.length : slash;

  for (const byte of encoder.encode(source.slice(index, end))) bytes.push(byte);

  return end - 1;
}

export function decodeGitPath(value: string) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const source = value.slice(1, -1); const bytes: number[] = []; const encoder = new TextEncoder();

  if (!source.includes("\\")) return new TextDecoder().decode(encoder.encode(source));
  const escapes = new Map(Object.entries({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\\": 92, '"': 34 }));

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\") { index = appendPathText(bytes, encoder, source, index); continue; }

    const next = source[++index];

    if (next === undefined) break;

    if (/[0-7]/.test(next)) { const octal = required(source.slice(index).match(/^[0-7]{1,3}/))[0]; index += octal.length - 1; bytes.push(Number.parseInt(octal, 8)); }
    else if (escapes.has(next)) bytes.push(required(escapes.get(next)));
    else bytes.push(...encoder.encode(next));
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function quotedSourceLength(value: string) {
  if (!value.startsWith('"')) return 0;
  let next = 0; let afterNext = 0;

  for (let index = value.length - 1; index >= 1; index -= 1) {
    const escaped = value[index] === '\\' && !/[\n\r\u2028\u2029]/.test(value[index + 1] ?? '\n');
    const continuation = escaped ? afterNext : 0;
    const fallback = value[index] !== '"' ? next : value[index + 1] === ' ' ? index + 2 : 0;
    afterNext = next;
    next = continuation || fallback;
  }

  return next;
}

export function displayPath(header: string) {
  const paths = header.replace(/^diff --git /, "");
  const quotedEnd = quotedSourceLength(paths);

  if (quotedEnd) return decodeGitPath(paths.slice(quotedEnd)).replace(/^b\//, "");
  const separators = [...paths.matchAll(/ (?=b\/|"b\/)/g)].map((match) => match.index);
  const separator = separators.find((index) => paths.slice(0, index).replace(/^a\//, "") === decodeGitPath(paths.slice(index + 1)).replace(/^b\//, "")) ?? separators[0];

  return decodeGitPath(separator === undefined ? paths : paths.slice(separator + 1)).replace(/^b\//, "");
}
