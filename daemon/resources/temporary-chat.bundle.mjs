"use strict";(()=>{var g=Object.create;var R=Object.defineProperty;var y=Object.getOwnPropertyDescriptor;var F=Object.getOwnPropertyNames;var M=Object.getPrototypeOf,U=Object.prototype.hasOwnProperty;var T=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(s,i)=>(typeof require<"u"?require:s)[i]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var p=(e,s)=>()=>(e&&(s=e(e=0)),s);var l=(e,s)=>()=>(s||e((s={exports:{}}).exports,s),s.exports);var D=(e,s,i,n)=>{if(s&&typeof s=="object"||typeof s=="function")for(let E of F(s))!U.call(e,E)&&E!==i&&R(e,E,{get:()=>s[E],enumerable:!(n=y(s,E))||n.enumerable});return e};var L=(e,s,i)=>(i=e!=null?g(M(e)):{},D(s||!e||!e.__esModule?R(i,"default",{value:e,enumerable:!0}):i,e));function Y(e){e.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");try{e.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
      CREATE TABLE IF NOT EXISTS session_file_metadata (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE, session_path TEXT NOT NULL, modified_ns TEXT NOT NULL, size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_file_writes (session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE); CREATE TRIGGER IF NOT EXISTS session_file_metadata_moved AFTER UPDATE ON sessions WHEN OLD.session_path IS NOT NEW.session_path BEGIN DELETE FROM session_file_metadata WHERE session_id=OLD.session_id; END;`),e.exec(`      CREATE TABLE IF NOT EXISTS session_goals (
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
`),e.exec("COMMIT")}catch(s){throw e.exec("ROLLBACK"),s}}function O(e){let s=T("node:path").join(e,"sessions.sqlite"),i=new(T("node:sqlite")).DatabaseSync(s);try{return T("node:fs").chmodSync(s,384),Y(i),i}catch(n){throw i.close(),n}}var I=p(()=>{"use strict"});function c(e){try{let s=o.lstatSync(e);if(!s.isDirectory()||s.isSymbolicLink())throw new Error("Temporary chat path must be a directory, not a link");return!0}catch(s){if(s.code==="ENOENT")return!1;throw s}}function N(e){let s=o.openSync(e,o.constants.O_RDONLY|o.constants.O_DIRECTORY);try{o.fsyncSync(s)}finally{o.closeSync(s)}}function b(e,s,i,n){let E=e.prepare("INSERT INTO temporary_chat_allocations (session_id, original_path) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING");if(E.run(n,i),e.exec("BEGIN IMMEDIATE"),E.run(n,i),e.prepare("SELECT original_path FROM temporary_chat_allocations WHERE session_id=?").get(n).original_path!==i)throw new Error("Temporary chat directory does not match its saved record");c(t.join(s,"tmp"))||o.mkdirSync(t.join(s,"tmp")),c(i)||o.mkdirSync(i),N(t.join(s,"tmp")),N(s)}function B(e){let s=o.openSync(e,o.constants.O_RDONLY|o.constants.O_NOFOLLOW|o.constants.O_NONBLOCK);try{if(!o.fstatSync(s).isFile())return null;let i=[],n=Buffer.alloc(4096);for(let E=0;E<65536;){let a=o.readSync(s,n,0,n.length,null);if(!a)return null;E+=a;let r=n.subarray(0,a).indexOf(10);if(i.push(Buffer.from(n.subarray(0,r<0?a:r))),r>=0)return Buffer.concat(i).toString("utf8")}return null}finally{o.closeSync(s)}}function d(e,s){return{deferred:`Temporary folder cleanup deferred: cannot read the working folder from ${e}: ${s}`}}function q(e,s){let i=e.prepare("PRAGMA data_version").get().data_version,n=e.prepare("SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL").all(),E=[];for(let r of n)if(r.session_id!==s)try{let _=B(r.session_path);if(_===null)return d(r.session_path,"missing, oversized, or non-regular chat header");let u=JSON.parse(_).cwd;if(!t.isAbsolute(u))return d(r.session_path,"working folder path is not absolute");E.push(t.resolve(u))}catch(_){if(_.code==="ENOENT")continue;return d(r.session_path,_.message)}let a=e.prepare("SELECT session_id, cwd || COALESCE(session_path, '') AS text FROM queue_origins UNION ALL SELECT session_id, message || details_json AS text FROM queue_items UNION ALL SELECT q.session_id, a.details_json AS text FROM queue_attachments a JOIN queue_items q USING(queue_item_id)").all().filter(r=>r.session_id!==s).map(r=>r.text);return{version:i,directories:E,queued:a}}function P(e,s){return e.directories.some(i=>i===s||i.startsWith(s+t.sep))||e.queued.some(i=>i.includes(s))}function w(e,s,i){let n=q(e,i);n.deferred&&console.error(n.deferred),e.exec("BEGIN IMMEDIATE"),!(n.deferred||e.prepare("PRAGMA data_version").get().data_version!==n.version||P(n,s))&&j(e,s,i)}function j(e,s,i){let n=e.prepare("SELECT original_path FROM temporary_chat_allocations WHERE session_id=?").get(i),E=!e.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(i);if(c(s))try{E&&n?.original_path===s?o.rmSync(s,{recursive:!0}):o.rmdirSync(s)}catch(a){if(["ENOTEMPTY","EEXIST"].includes(a.code))return;if(a.code!=="ENOENT")throw a}c(t.dirname(s))&&N(t.dirname(s)),e.prepare("DELETE FROM temporary_chat_allocations WHERE session_id=? AND original_path=?").run(i,s),e.prepare("DELETE FROM sessions WHERE session_id=? AND session_path IS NULL").run(i)}function S(e){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.id))throw new Error("Invalid temporary chat session ID");if(!["create","remove"].includes(e.action))throw new Error("Invalid temporary chat action");let s=t.resolve(e.root??t.join(T("node:os").homedir(),process.env.PIOP_STORAGE_DIRECTORY??".piop")),i=t.join(s,"tmp",e.id);if(e.action==="remove"&&e.path!==i)throw new Error("Refusing to remove a directory outside the temporary chat root");if(!c(s)){if(e.action==="remove")return null;o.mkdirSync(s,{recursive:!0,mode:448})}c(t.join(s,"tmp"));let n=O(s);try{n.exec("CREATE TABLE IF NOT EXISTS temporary_chat_allocations (session_id TEXT PRIMARY KEY, original_path TEXT NOT NULL UNIQUE)"),e.action==="create"?b(n,s,i,e.id):w(n,i,e.id),n.exec("COMMIT")}finally{n.close()}return e.action==="create"?i:null}var o,t,f=p(()=>{"use strict";o=L(T("node:fs")),t=L(T("node:path"));I()});var X=l((J,m)=>{"use strict";var G=T("node:fs"),C=Symbol("host-script-delegated"),A;function h(){return A??=G.readFileSync(0,"utf8"),A}function K(e){let s={ok:!1,error:e instanceof Error?e.message:String(e)};return typeof e?.state=="string"&&(s.state=e.state),typeof e?.warning=="string"&&(s.warning=e.warning),s}function H(e){Promise.resolve().then(()=>e(JSON.parse(h()))).then(s=>{s!==C&&process.stdout.write(JSON.stringify({ok:!0,result:s??null}))},s=>{process.stdout.write(JSON.stringify(K(s))),process.exitCode=1})}m.exports={hostScript:H,readRequestText:h,delegated:C}});var W=l(()=>{f();var{hostScript:x}=X();x(S)});W();})();
