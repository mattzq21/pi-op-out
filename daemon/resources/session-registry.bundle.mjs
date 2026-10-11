"use strict";(()=>{var h=Object.create;var _=Object.defineProperty;var X=Object.getOwnPropertyDescriptor;var m=Object.getOwnPropertyNames;var g=Object.getPrototypeOf,y=Object.prototype.hasOwnProperty;var t=(s=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(s,{get:(e,i)=>(typeof require<"u"?require:e)[i]}):s)(function(s){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+s+'" is not supported')});var F=(s,e)=>()=>(s&&(e=s(s=0)),e);var a=(s,e)=>()=>(e||s((e={exports:{}}).exports,e),e.exports);var D=(s,e,i,o)=>{if(e&&typeof e=="object"||typeof e=="function")for(let E of m(e))!y.call(s,E)&&E!==i&&_(s,E,{get:()=>e[E],enumerable:!(o=X(e,E))||o.enumerable});return s};var M=(s,e,i)=>(i=s!=null?h(g(s)):{},D(e||!s||!s.__esModule?_(i,"default",{value:s,enumerable:!0}):i,s));var L=a((Z,I)=>{"use strict";var U=t("node:fs"),u=Symbol("host-script-delegated"),N;function R(){return N??=U.readFileSync(0,"utf8"),N}function b(s){let e={ok:!1,error:s instanceof Error?s.message:String(s)};return typeof s?.state=="string"&&(e.state=s.state),typeof s?.warning=="string"&&(e.warning=s.warning),e}function Y(s){Promise.resolve().then(()=>s(JSON.parse(R()))).then(e=>{e!==u&&process.stdout.write(JSON.stringify({ok:!0,result:e??null}))},e=>{process.stdout.write(JSON.stringify(b(e))),process.exitCode=1})}I.exports={hostScript:Y,readRequestText:R,delegated:u}});function d(s){s.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");try{s.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
      CREATE TABLE IF NOT EXISTS session_file_metadata (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, session_path TEXT NOT NULL, modified_ns TEXT NOT NULL, size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_file_writes (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE); CREATE TRIGGER IF NOT EXISTS session_file_metadata_moved AFTER UPDATE ON sessions WHEN OLD.session_path IS NOT NEW.session_path BEGIN DELETE FROM session_file_metadata WHERE session_id=OLD.session_id; END;`),s.exec(`      CREATE TABLE IF NOT EXISTS session_goals (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete')),
        token_budget INTEGER CHECK(token_budget > 0),
        tokens_used INTEGER NOT NULL CHECK(tokens_used >= 0),
        elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0));
      CREATE TABLE IF NOT EXISTS session_goal_accounting (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        goal_id TEXT NOT NULL, current INTEGER NOT NULL CHECK(current IN (0, 1)), usage_json TEXT NOT NULL,
        PRIMARY KEY(session_id, goal_id));
      CREATE UNIQUE INDEX IF NOT EXISTS session_goal_current ON session_goal_accounting(session_id) WHERE current=1;
      CREATE TABLE IF NOT EXISTS session_sidebar (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, modified_at INTEGER NOT NULL, summary_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_child_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        complete INTEGER NOT NULL CHECK(complete IN (0, 1)));
      CREATE TABLE IF NOT EXISTS session_children (
        parent_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('subagent', 'review')),
        PRIMARY KEY(parent_id, child_id));
      CREATE INDEX IF NOT EXISTS session_children_child ON session_children(child_id);
      CREATE TABLE IF NOT EXISTS session_mailbox_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_mailbox (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL, sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        message_json TEXT NOT NULL, PRIMARY KEY(session_id, delivery_id));
      CREATE INDEX IF NOT EXISTS session_mailbox_order ON session_mailbox(session_id, sequence);
      CREATE TABLE IF NOT EXISTS session_subagent_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_subagent_runs (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, started_at REAL NOT NULL, run_json TEXT NOT NULL,
        PRIMARY KEY(session_id, run_id));
      CREATE INDEX IF NOT EXISTS session_subagent_order ON session_subagent_runs(session_id, started_at);
      CREATE TABLE IF NOT EXISTS session_group_state (id INTEGER PRIMARY KEY CHECK(id=1), initialized INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_groups (
        group_id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, cwd TEXT,
        host_id TEXT, host_name TEXT);
      CREATE TABLE IF NOT EXISTS session_group_assignments (session_key TEXT PRIMARY KEY, group_id TEXT);
      CREATE TABLE IF NOT EXISTS session_group_removed_projects (project_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_publications (publication_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_ownership (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_restore_receipts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_candidates (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, retry_at REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS retention_retry_order ON retention_candidates(retry_at, record_id);
      CREATE TABLE IF NOT EXISTS cleanup_requests (kind TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_directories (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS goal_asset_dependencies (directory TEXT NOT NULL, identity TEXT NOT NULL, record_json TEXT, PRIMARY KEY(directory, identity));
      CREATE TABLE IF NOT EXISTS goal_asset_reclamations (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_transcripts (record_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_item_sequence (id INTEGER PRIMARY KEY CHECK(id=1), last_id INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_item_sequence VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS queue_origins (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        cwd TEXT NOT NULL, session_path TEXT);
      CREATE TABLE IF NOT EXISTS queue_items (
        queue_item_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        queue_position INTEGER NOT NULL CHECK(queue_position BETWEEN 1 AND 100),
        message TEXT NOT NULL, behavior TEXT NOT NULL CHECK(behavior IN ('steer', 'followUp')),
        details_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue_items_order ON queue_items(session_id, queue_position);
      CREATE TRIGGER IF NOT EXISTS queue_items_limit BEFORE INSERT ON queue_items
        WHEN NOT EXISTS(SELECT 1 FROM queue_items WHERE queue_item_id=NEW.queue_item_id)
          AND (SELECT count(*) FROM queue_items WHERE session_id=NEW.session_id)>=100
        BEGIN SELECT RAISE(ABORT, 'A session can have at most 100 queued items'); END;
      CREATE TABLE IF NOT EXISTS queue_attachments (
        attachment_id INTEGER PRIMARY KEY,
        queue_item_id INTEGER NOT NULL REFERENCES queue_items(queue_item_id) ON DELETE CASCADE,
        attachment_position INTEGER NOT NULL CHECK(attachment_position>=1),
        media_type TEXT NOT NULL, data BLOB NOT NULL, details_json TEXT NOT NULL,
        UNIQUE(queue_item_id, attachment_position));
      CREATE TABLE IF NOT EXISTS session_directories (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, cwd TEXT NOT NULL, checked_at INTEGER NOT NULL, directory_exists INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_transactions (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('archive', 'delete', 'restore')), state TEXT NOT NULL CHECK(state IN ('prepared', 'committed')), journal_json TEXT NOT NULL);
`),s.exec("COMMIT")}catch(e){throw s.exec("ROLLBACK"),e}}function O(s){c.mkdirSync(s,{recursive:!0,mode:448});let e=q(s);try{return B(e)}finally{e.close()}}function B(s){let e=s.prepare("INSERT INTO sessions (session_id) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM storage_transactions s, json_each(s.journal_json, '$.targets') t WHERE json_extract(t.value, '$.sessionId')=?1) ON CONFLICT(session_id) DO NOTHING");for(;;){let i=t("node:crypto").randomUUID();if(Number(e.run(i).changes)===1)return i}}function q(s){let e=t("node:path").join(s,"sessions.sqlite"),i=new(t("node:sqlite")).DatabaseSync(e);try{return t("node:fs").chmodSync(e,384),d(i),i}catch(o){throw i.close(),o}}var c,S=F(()=>{"use strict";c=M(t("node:fs"))});var A=a((ss,p)=>{"use strict";S();var r=t("node:fs"),T=t("node:path"),P=t("node:os"),{createHash:j}=t("node:crypto"),{DatabaseSync:v}=t("node:sqlite"),n;function K(s){let e;try{e=r.statSync(s).isDirectory()}catch(i){if(!["ENOENT","ENOTDIR"].includes(i.code))throw i;e=!1}return e}function l(s){return T.isAbsolute(s.sessionPath||"")?!!n.prepare("SELECT 1 FROM sessions WHERE session_id=? AND session_path=?").get(s.sessionId,s.sessionPath):!1}function w(s,e,i){n.prepare(`INSERT INTO session_directories (session_id, cwd, checked_at, directory_exists) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, checked_at=excluded.checked_at, directory_exists=excluded.directory_exists
    WHERE excluded.checked_at >= session_directories.checked_at`).run(s.sessionId,s.cwd,e,Number(i))}function H(s){if(!s.sessionId||!T.isAbsolute(s.cwd||"")||!l(s))return;let e=s.checkedAt||Date.now(),i=K(s.cwd);n.exec("BEGIN IMMEDIATE");try{l(s)&&w(s,e,i),n.exec("COMMIT")}catch(o){throw n.exec("ROLLBACK"),o}}function G(s){let e=r.openSync(s,r.constants.O_RDONLY|r.constants.O_NONBLOCK);try{if(!r.fstatSync(e).isFile())throw new Error("Session transcript is not a regular file");let i=Buffer.alloc(64*1024),o=r.readSync(e,i,0,i.length,0),E=JSON.parse(i.subarray(0,o).toString("utf8").split(`
`)[0]);if(E.type!=="session"||!E.id||E.id!==String(E.id))throw new Error("Missing session identity");return E.id}finally{r.closeSync(e)}}function W(s){let e=j("sha256").update(s).digest("hex");n.exec("BEGIN IMMEDIATE");try{let i=n.prepare("SELECT json_extract(record_json, '$.sessionId') AS id FROM external_transcripts WHERE record_id=? AND json_extract(record_json, '$.path')=?").get(e,s),o=i?i.id??G(s):null;return i&&i.id===null&&n.prepare("UPDATE external_transcripts SET record_json=json_set(record_json, '$.sessionId', ?) WHERE record_id=?").run(o,e),n.exec("COMMIT"),o}catch(i){throw n.exec("ROLLBACK"),i}}function k(s,e){let i=n.prepare("SELECT session_id FROM sessions WHERE session_path=?").get(e.path)?.session_id,E=[T.resolve(s),r.realpathSync(s)].some(C=>["sessions","archived"].some(f=>T.resolve(e.path).startsWith(T.join(C,f)+T.sep)));if(!i&&E)throw new Error("Session path is not registered");return i??W(e.path)}function $(s){let e=s.root||T.join(P.homedir(),process.env.PIOP_STORAGE_DIRECTORY||".piop");r.mkdirSync(e,{recursive:!0,mode:448});let i=T.join(e,"sessions.sqlite");n=new v(i);try{if(r.chmodSync(i,384),d(n),s.action==="reserve")return O(e);if(s.action==="identity")return k(e,s);if(s.action==="ids")return n.prepare("SELECT session_id FROM sessions").all().map(o=>o.session_id);if(s.action==="record")return H(s);throw new Error("Unknown session registry action")}finally{n.close(),n=void 0}}p.exports={registryAction:$}});var z=a(()=>{var{hostScript:J}=L(),{registryAction:V}=A();J(V)});z();})();
