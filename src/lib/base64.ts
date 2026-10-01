declare global {
  interface Uint8Array {
    toBase64?: () => string;
  }
}

export function encodeBase64(bytes: Uint8Array) {
  const native = bytes.toBase64;

  if (native) return native.call(bytes);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));

  return btoa(binary);
}

export function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return bytes;
}
