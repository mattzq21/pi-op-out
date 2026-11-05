const fs = require('node:fs');
const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { isAbsolute } = require('node:path');

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }), cwd: Type.String() });

const validSessionHeader = header => Check(headerSchema, header) && isAbsolute(header.cwd);

// The header of the transcript file, or undefined when the file has no valid header.
function readSessionHeader(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, length).indexOf(10);

    if (end < 0) return undefined;
    const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));

    return validSessionHeader(header) ? header : undefined;
  } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  finally { fs.closeSync(descriptor); }
}

module.exports = { validSessionHeader, readSessionHeader };
