const { hostScript } = require('./host-script.cjs');
const { checkedRelocation } = require('./relocate-session.cjs');

hostScript(checkedRelocation);
