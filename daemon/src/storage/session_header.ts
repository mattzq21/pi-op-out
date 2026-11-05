import fs from 'node:fs';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { isAbsolute } from 'node:path';

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }), cwd: Type.String() });

export interface SessionHeader { type: 'session'; id: string; cwd: string; [key: string]: unknown }

const validSessionHeader = (header: unknown): header is SessionHeader => Boolean(Check(headerSchema, header) && isAbsolute((header as SessionHeader).cwd));

// The header of the transcript file, or undefined when the file has no valid header.
function readSessionHeader(file: string): SessionHeader | undefined {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | ((fs.constants as any).O_NOFOLLOW ?? 0));

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

export { validSessionHeader, readSessionHeader };
