import { Type } from 'typebox';
import { Check } from 'typebox/value';

const headerSchema = Type.Object({ type: Type.Literal('session'), id: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }) });

function canonicalTranscriptBasename(header) {
  if (!Check(headerSchema, header)) throw new Error('Invalid conversation header for transcript mapping');

  return `session-${header.id.toLowerCase()}.jsonl`;
}

export { canonicalTranscriptBasename };
