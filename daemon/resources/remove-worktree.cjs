const { preserveAndRemoveWorktree, authorizeWorktreeRemoval } = require('./worktree-checkpoint-preservation.cjs');

try { preserveAndRemoveWorktree(process.argv[1], authorizeWorktreeRemoval); }
catch (error) { console.error(error.message); process.exitCode = 1; }
