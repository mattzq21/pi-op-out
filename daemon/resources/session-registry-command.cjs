const { hostScript } = require('./host-script.cjs');
const { registryAction } = require('./session-registry.cjs');

hostScript(registryAction);
