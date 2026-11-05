const path = require('node:path');
const { Type } = require('typebox');
const { Check } = require('typebox/value');

const ownerSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }), sessionPath: Type.String() });

const recoverySchema = Type.Object({ id: Type.String(), state: Type.String(), mode: Type.String(), directory: Type.String(), originalCwd: Type.String(), owners: Type.Array(ownerSchema, { minItems: 1 }) });

// The missing-folder recoveries that the database keeps, by container folder.
function recoveryRoots(profile, warnings) {
  const roots = new Map();

  try {
    for (const row of require('./session-database.cjs').recoveryRecords(profile)) {
      const container = path.join(profile, 'recovery', row.record_id);
      const record = JSON.parse(row.record_json);

      if (!Check(recoverySchema, record)) { warnings.push(`${container}: invalid recovery record`); continue; }
      roots.set(container, {
        path: container, ownership: 'owned', state: record.state, workdir: record.directory,
        provenance: [`Recovery ownership v1: ${record.mode}; original directory: ${record.originalCwd}`],
        owners: record.owners.map(owner => ({ ...owner, kind: 'recovery-owner' })),
      });

      if (record.state !== 'published') warnings.push(`${container}: retained ${record.state} recovery; publication is incomplete and reclaimable space is unknown`);
    }
  } catch (error) { warnings.push(`${path.join(profile, 'recovery')}: recovery records unavailable: ${error.message}`); }

  return roots;
}

module.exports = { recoveryRoots };
