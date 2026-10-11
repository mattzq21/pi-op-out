const { hostScript } = require('./host-script.cjs');
const { textContents } = require('./session-broker/goal-dependencies.cjs');

/** Returns the saved text of each goal text file in request.directory. */
hostScript(request => textContents(request.root, request.directory).map(entry => entry.text));
