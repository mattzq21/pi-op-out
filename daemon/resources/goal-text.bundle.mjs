"use strict";(()=>{var I=Object.create;var T=Object.defineProperty;var S=Object.getOwnPropertyDescriptor;var A=Object.getOwnPropertyNames;var C=Object.getPrototypeOf,f=Object.prototype.hasOwnProperty;var o=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(s,n)=>(typeof require<"u"?require:s)[n]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var a=(e,s)=>()=>(e&&(s=e(e=0)),s);var c=(e,s)=>()=>(s||e((s={exports:{}}).exports,s),s.exports);var y=(e,s,n,t)=>{if(s&&typeof s=="object"||typeof s=="function")for(let E of A(s))!f.call(e,E)&&E!==n&&T(e,E,{get:()=>s[E],enumerable:!(t=S(s,E))||t.enumerable});return e};var g=(e,s,n)=>(n=e!=null?I(C(e)):{},y(s||!e||!e.__esModule?T(n,"default",{value:e,enumerable:!0}):n,e));function m(e){e.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");try{e.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
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
`),e.exec("COMMIT")}catch(s){throw e.exec("ROLLBACK"),s}}function N(e){let s=o("node:path").join(e,"sessions.sqlite"),n=new(o("node:sqlite")).DatabaseSync(s);try{return o("node:fs").chmodSync(s,384),m(n),n}catch(t){throw n.close(),t}}var _=a(()=>{"use strict"});function D(e,s){let n=N(e);try{return n.exec("CREATE TABLE IF NOT EXISTS goal_text_files (directory TEXT NOT NULL, identity TEXT NOT NULL, names_json TEXT NOT NULL, PRIMARY KEY(directory, identity)); CREATE TABLE IF NOT EXISTS goal_text_contents (directory TEXT NOT NULL, identity TEXT NOT NULL, contents_json TEXT NOT NULL, PRIMARY KEY(directory, identity))"),s(n)}finally{n.close()}}function h(e){let s=i.lstatSync(e,{bigint:!0});if(!s.isDirectory()||i.realpathSync(e)!==e)throw new Error("Goal dependency directory changed");return`${s.dev}:${s.ino}`}function F(e,s,n){return e.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goal_ownership'").get()?!!e.prepare("SELECT 1 FROM goal_ownership WHERE directory=? AND identity IN (?, '') AND record_json IS NULL").get(s,n):!1}function d(e,s){let n=h(s);return D(e,t=>{let r=t.prepare("SELECT contents_json FROM goal_text_contents WHERE directory=? AND identity=?").get(s,n);if(!r&&F(t,s,n))return[];if(!r)throw new Error("Goal text contents are not registered");return JSON.parse(r.contents_json)})}var i,u=a(()=>{"use strict";i=g(o("node:fs"));_()});var p=c((P,l)=>{"use strict";var M=o("node:fs"),U="require('node:vm').runInThisContext(require('node:fs').readFileSync(process.argv[1], 'utf8'), { filename: process.argv[1], importModuleDynamically: specifier => import(specifier) })",L=Symbol("host-script-delegated"),R;function O(){return R??=M.readFileSync(0,"utf8"),R}function Y(e){let s={ok:!1,error:e instanceof Error?e.message:String(e)};return typeof e?.state=="string"&&(s.state=e.state),typeof e?.warning=="string"&&(s.warning=e.warning),s}function x(e){return Promise.resolve().then(()=>e(JSON.parse(O()))).then(s=>{s!==L&&process.stdout.write(JSON.stringify({ok:!0,result:s??null}))},s=>{process.stdout.write(JSON.stringify(Y(s))),process.exitCode=1})}l.exports={hostScript:x,readRequestText:O,delegated:L,scriptLoader:U}});var j=c(()=>{u();var{hostScript:q}=p();q(e=>d(e.root,e.directory).map(s=>s.text))});j();})();
