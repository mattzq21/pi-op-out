import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { isAbsolute } from 'node:path';

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }), cwd: Type.String() });

const validSessionHeader = header => Check(headerSchema, header) && isAbsolute(header.cwd);

export { validSessionHeader };
