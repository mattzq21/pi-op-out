const { Type } = require("typebox");

const { Check } = require("typebox/value");

const { isAbsolute } = require("node:path");

const commitSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });

const unavailableSchema = Type.Object({ unavailable: Type.Literal(true) });

const promptSchema = Type.Object({ key: Type.String({ pattern: "^[a-zA-Z0-9-]+$" }), owner: Type.String(), commit: commitSchema, base: Type.Union([Type.Null(), commitSchema]) });

const snapshotSchema = Type.Object({ repositoryRoot: Type.String(), ref: Type.String({ pattern: "^refs/pi-session-snapshots/[^\\r\\n]*$" }), commit: commitSchema });

const headerSchema = Type.Object({ type: Type.Literal("session"), id: Type.String({ minLength: 1 }), cwd: Type.String() });

const unavailableCheckpoint = data => Check(unavailableSchema, data);

const promptCheckpoint = data => Check(promptSchema, data);

const snapshotCheckpoint = data => Check(snapshotSchema, data) && isAbsolute(data.repositoryRoot);

const validSessionHeader = header => Check(headerSchema, header) && isAbsolute(header.cwd);

module.exports = { unavailableCheckpoint, promptCheckpoint, snapshotCheckpoint, validSessionHeader };
