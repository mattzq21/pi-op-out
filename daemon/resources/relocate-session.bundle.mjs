"use strict";(()=>{var ee=Object.create;var p=Object.defineProperty;var se=Object.getOwnPropertyDescriptor;var ne=Object.getOwnPropertyNames;var re=Object.getPrototypeOf,oe=Object.prototype.hasOwnProperty;var i=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(s,n)=>(typeof require<"u"?require:s)[n]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var u=(e,s)=>()=>(e&&(s=e(e=0)),s);var N=(e,s)=>()=>(s||e((s={exports:{}}).exports,s),s.exports),m=(e,s)=>{for(var n in s)p(e,n,{get:s[n],enumerable:!0})},A=(e,s,n,r)=>{if(s&&typeof s=="object"||typeof s=="function")for(let o of ne(s))!oe.call(e,o)&&o!==n&&p(e,o,{get:()=>s[o],enumerable:!(r=se(s,o))||r.enumerable});return e};var l=(e,s,n)=>(n=e!=null?ee(re(e)):{},A(s||!e||!e.__esModule?p(n,"default",{value:e,enumerable:!0}):n,e)),C=e=>A(p({},"__esModule",{value:!0}),e);var F=N((be,w)=>{"use strict";var ie=i("node:fs"),te="require('node:vm').runInThisContext(require('node:fs').readFileSync(process.argv[1], 'utf8'), { filename: process.argv[1], importModuleDynamically: specifier => import(specifier) })",b=Symbol("host-script-delegated"),g;function X(){return g??=ie.readFileSync(0,"utf8"),g}function ce(e){let s={ok:!1,error:e instanceof Error?e.message:String(e)};return typeof e?.state=="string"&&(s.state=e.state),typeof e?.warning=="string"&&(s.warning=e.warning),s}function ae(e){return Promise.resolve().then(()=>e(JSON.parse(X()))).then(s=>{s!==b&&process.stdout.write(JSON.stringify({ok:!0,result:s??null}))},s=>{process.stdout.write(JSON.stringify(ce(s))),process.exitCode=1})}w.exports={hostScript:ae,readRequestText:X,delegated:b,scriptLoader:te}});function D(e){let s=t.openSync(e,"r");try{t.fsyncSync(s)}finally{t.closeSync(s)}}var t,U=u(()=>{"use strict";t=l(i("node:fs"))});function Te(e,s=!1,n=!1){if(!f){let o="bun:ffi",{dlopen:T,read:_}=i(o),I=T("libc.so.6",{flock:{args:["i32","i32"],returns:"i32"},__errno_location:{args:[],returns:"ptr"}}),h=I.symbols.__errno_location();if(!h)throw new Error("Could not get flock errno address");f={library:I,read:_,errno:h}}let r;do r=f.library.symbols.flock(e,(s?1:2)|(n?4:0))===0?0:f.read.i32(f.errno);while(r===4);if(r===11)return!1;if(r)throw new Error(`flock failed (errno ${r})`);return!0}function ue(){return process.versions.bun?process.execPath:process.env.PIOP_BUN||"bun"}function le(e=!1,s=!1,n=0,r=3){return["-e",de,String(r),String(+e),String(+s),String(n)]}function fe(e,s){if(e===0)return!0;if(e===75)return!1;throw new Error(s.trim()||"Could not acquire file lock")}function M(e,s=!1,n=!1,r=0){if(process.versions.bun)return Te(e,s,n);let o=(0,S.spawnSync)(ue(),le(s,n),{env:{...process.env,BUN_BE_BUN:"1"},timeout:r,stdio:["ignore","ignore","pipe",e]});if(o.error)throw o.error;return fe(o.status,o.stderr.toString())}var S,f,v,de,q=u(()=>{"use strict";S=i("node:child_process");v=`let libc;
function nativeLock(fd, shared = false, nonblocking = false) {
  if (!libc) {
    const module = 'bun:ffi';
    const { dlopen, read } = require(module);
    const library = dlopen('libc.so.6', { flock: { args: ['i32', 'i32'], returns: 'i32' }, __errno_location: { args: [], returns: 'ptr' } });
    const errno = library.symbols.__errno_location();
    if (!errno) throw new Error('Could not get flock errno address');
    libc = { library, read, errno };
  }
  let error;
  do { error = libc.library.symbols.flock(fd, (shared ? 1 : 2) | (nonblocking ? 4 : 0)) === 0 ? 0 : libc.read.i32(libc.errno); } while (error === 4);
  if (error === 11) return false;
  if (error) throw new Error(\`flock failed (errno \${error})\`);
  return true;
}`,de=`${v}
const [fd, shared, nonblocking, wait] = process.argv.slice(1).map(Number);
try {
  if (wait) {
    const source = ${JSON.stringify(v)} + '; self.onmessage = ({data}) => { try { self.postMessage(nativeLock(...data)); } catch (error) { self.postMessage({error: error.message}); } };';
    const url = URL.createObjectURL(new Blob([source], {type: 'application/javascript'}));
    const worker = new Worker(url);
    setTimeout(() => process.exit(75), wait);
    worker.onmessage = ({data}) => { if (data?.error) { console.error(data.error); process.exit(1); } process.exit(data ? 0 : 75); };
    worker.onerror = event => { console.error(event.message); process.exit(1); };
    worker.postMessage([fd, !!shared, !!nonblocking]);
  } else process.exit(nativeLock(fd, !!shared, !!nonblocking) ? 0 : 75);
} catch (error) { console.error(error.message); process.exit(1); }
`});function _e(e){E.mkdirSync(e,{recursive:!0,mode:448});let s=E.openSync(k.join(e,"reference-publication.lock"),E.constants.O_CREAT|E.constants.O_RDWR|E.constants.O_NOFOLLOW,384);try{if(!E.fstatSync(s).isFile())throw new Error("Invalid reference publication lock");return s}catch(n){throw E.closeSync(s),n}}function pe(e,s,n,r){if(r&&s===75){E.closeSync(e);return}if(s!==0)throw new Error(n.trim()||"Could not lock reference publication");return()=>E.closeSync(e)}function R(e,s=!1,n=!1){let r=_e(e);try{return pe(r,M(r,s,n)?0:75,"",n)}catch(o){throw E.closeSync(r),o}}var E,k,Y=u(()=>{"use strict";q();E=l(i("node:fs")),k=l(i("node:path"))});var B=u(()=>{"use strict";Y()});function Ne(e){e.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");try{e.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, session_path TEXT); CREATE INDEX IF NOT EXISTS sessions_path ON sessions(session_path);
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
`),e.exec("COMMIT")}catch(s){throw e.exec("ROLLBACK"),s}}function y(e){let s=i("node:path").join(e,"sessions.sqlite"),n=new(i("node:sqlite")).DatabaseSync(s);try{return i("node:fs").chmodSync(s,384),Ne(n),n}catch(r){throw n.close(),r}}function L(e){let s=d.dirname(e);for(;d.dirname(s)!==s;){if(["sessions","archived"].includes(d.basename(s)))return d.dirname(s);s=d.dirname(s)}throw new Error("Conversation is outside session storage")}var d,P=u(()=>{"use strict";d=l(i("node:path"))});function x(e){let s;try{s=L(e)}catch{return}let n=y(s);try{n.exec("BEGIN IMMEDIATE"),n.prepare("DELETE FROM session_file_metadata WHERE session_path=?").run(e),n.prepare("INSERT INTO session_file_writes SELECT session_id FROM sessions WHERE session_path=? ON CONFLICT DO NOTHING").run(e),n.exec("COMMIT")}finally{n.close()}}function K(e){let s;try{s=L(e)}catch{return}let n=y(s);try{n.exec("BEGIN IMMEDIATE");let r=Re(e);n.prepare(`INSERT INTO session_file_metadata SELECT session_id, session_path, ?, ? FROM sessions WHERE session_path=?
      ON CONFLICT(session_id) DO UPDATE SET session_path=excluded.session_path, modified_ns=excluded.modified_ns, size=excluded.size`).run(String(r.mtimeNs),r.size,e),n.prepare("DELETE FROM session_file_writes WHERE session_id IN (SELECT session_id FROM sessions WHERE session_path=?)").run(e),n.exec("COMMIT")}finally{n.close()}}function Re(e){let s=c.openSync(e,c.constants.O_RDONLY|c.constants.O_NOFOLLOW),n;try{if(n=c.fstatSync(s,{bigint:!0}),!n.isFile())throw new Error("Saved transcript is not a regular file");c.fsyncSync(s)}finally{c.closeSync(s)}let r=c.openSync(j.dirname(e),c.constants.O_RDONLY|c.constants.O_NOFOLLOW);try{c.fsyncSync(r)}finally{c.closeSync(r)}return n}var c,j,O=u(()=>{"use strict";P();c=l(i("node:fs")),j=l(i("node:path"))});var G={};m(G,{invalidate:()=>x});var H=u(()=>{O()});var W={};m(W,{remember:()=>K});var $=u(()=>{O()});var Z=N((Pe,Q)=>{"use strict";U();B();var a=i("node:fs"),{homedir:ye}=i("node:os"),{dirname:Le,join:J}=i("node:path"),{randomUUID:Oe}=i("node:crypto");function z(){return J(ye(),process.env.PIOP_STORAGE_DIRECTORY||".piop")}function V(e,s){let n=R(z(),!0);try{let r=a.realpathSync(s);if(!a.statSync(r).isDirectory())throw new Error("Project directory does not exist");Ie(e,r)}finally{n()}}function Ie(e,s){let n=a.readFileSync(e,"utf8").split(`
`),r=JSON.parse(n[0]);if(r.type!=="session")throw new Error("Invalid session header");r.cwd=s,n[0]=JSON.stringify(r);let o=`${e}.${Oe()}.tmp`,T;try{let _=a.statSync(e).mode&511;T=a.openSync(o,"wx",_),a.fchmodSync(T,_),a.writeFileSync(T,n.join(`
`)),a.fsyncSync(T),a.closeSync(T),T=void 0,(H(),C(G)).invalidate(e),a.renameSync(o,e),D(Le(e)),($(),C(W)).remember(e)}finally{T!==void 0&&a.closeSync(T),a.rmSync(o,{force:!0})}}function he(e){if(typeof e.sessionPath!="string"||typeof e.cwd!="string")throw new Error("Invalid relocation request");let s,n;try{s=a.realpathSync(J(z(),"sessions"))}catch(T){throw new Error(`Could not locate piop sessions: ${T.message}`)}try{n=a.realpathSync(e.sessionPath)}catch(T){throw new Error(`Could not locate session file: ${T.message}`)}if(!n.startsWith(s+"/")||!n.endsWith(".jsonl")||!a.statSync(n).isFile())throw new Error("Refusing to relocate a non-desktop session file");let r=e.cwd.trim(),o=!1;try{o=a.statSync(r).isDirectory()}catch{}if(!o)throw new Error(`Project directory does not exist: ${r}`);V(n,r)}Q.exports={relocateSession:V,checkedRelocation:he}});var Ce=N(()=>{var{hostScript:me}=F(),{checkedRelocation:Ae}=Z();me(Ae)});Ce();})();
