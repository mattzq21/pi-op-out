const { Type } = require('typebox');
const { Check } = require('typebox/value');
const { isAbsolute } = require('node:path');

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ minLength: 1 }), cwd: Type.String() });

const validSessionHeader = header => Check(headerSchema, header) && isAbsolute(header.cwd);

module.exports = { validSessionHeader };
