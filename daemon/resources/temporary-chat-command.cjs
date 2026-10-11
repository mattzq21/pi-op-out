const { hostScript } = require('./host-script.cjs');
const { main } = require('./temporary-chat.cjs');

hostScript(main);
