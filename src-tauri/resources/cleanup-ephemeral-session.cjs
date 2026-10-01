const fs = require('node:fs');

const { Type } = require('typebox');

const { Check } = require('typebox/value');

const sessionSchema = Type.Object({ type: Type.Literal('session'), id: Type.String() });

const repositorySchema = Type.String();

const { execFileSync } = require('node:child_process');

const file = process.argv[1];

if (fs.existsSync(file)) {
  const entries = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const header = entries[0];

  if (Check(sessionSchema, header)) {
    const id = header.id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+|\.+$/g, '') || 'session';
    const prefix = `refs/pi-session-snapshots/chats/${id}/`;
    const legacy = `refs/pi-session-snapshots/${id}`;
    const roots = new Set([header.cwd, header.checkpointRepositoryRoot, ...entries.map(entry => entry.data?.repositoryRoot)].filter(root => Check(repositorySchema, root)));
    const git = (cwd, args, input) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const repositories = new Set();

    for (const root of roots) {
      let common;

      try { common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']); } catch { continue; }

      if (repositories.has(common)) continue;
      repositories.add(common);
      const refs = git(common, ['for-each-ref', '--format=%(refname) %(objectname)', prefix, legacy]).split('\n').map(line => line.split(' ')).filter(([ref]) => ref.startsWith(prefix) || ref === legacy);

      if (refs.length) git(common, ['update-ref', '--stdin'], ['start', ...refs.map(([ref, commit]) => `delete ${ref} ${commit}`), 'prepare', 'commit', ''].join('\n'));
    }
  }
}

fs.rmSync(`${file}.loop-detection.json`, { force: true });

fs.rmSync(file.replace(/\.jsonl$/, '.diffs.json'), { force: true });

fs.rmSync(file, { force: true });
