const preparations = require('./goal-preparations.cjs');

function read(root, directory) { return preparations.read(root, directory); }

module.exports = { read };
