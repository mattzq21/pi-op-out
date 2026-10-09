import { runInNewContext } from "node:vm";
import { brotliCompressSync, constants } from "node:zlib";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function encode(bytes) {
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
  bytes.copy(padded);
  const blocks = [];

  for (let offset = 0; offset < padded.length; offset += 4) {
    let value = padded.readUInt32BE(offset);
    let block = "";

    for (let digit = 0; digit < 5; digit += 1) {
      block = alphabet[value % 85] + block;
      value = Math.floor(value / 85);
    }

    blocks.push(block);
  }

  return blocks.join("");
}

export function packNodeScript(contents) {
  const compressed = brotliCompressSync(contents, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const text = encode(compressed);
  const decoder = `(()=>{const a=${JSON.stringify(alphabet)},s=${JSON.stringify(text)},b=Buffer.alloc(s.length/5*4);for(let i=0;i<s.length;i+=5){let n=0;for(let j=0;j<5;j++)n=n*85+a.indexOf(s[i+j]);b.writeUInt32BE(n,i/5*4)}return b.subarray(0,${compressed.length})})()`;

  if (!runInNewContext(decoder, { Buffer }, { timeout: 1000 }).equals(compressed)) throw new Error("Packed script integrity check failed");

  return `eval(require("node:zlib").brotliDecompressSync(${decoder}).toString("utf8"));\n`;
}
