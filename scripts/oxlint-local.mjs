import { builtinRules } from 'eslint/use-at-your-own-risk';
import noComments from './oxlint-no-comments.mjs';
import daemonScope from './oxlint-daemon-scope.mjs';

const noAssertions = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'Type assertions are not allowed. Use inference, annotations, satisfies, or validated types.' },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'forbidden' });

    return { TSAsExpression: report, TSTypeAssertion: report };
  },
};

export default {
  meta: { name: 'local' },
  rules: {
    'no-comments': noComments,
    'no-assertions': noAssertions,
    'daemon-shared-bindings': daemonScope,
    'daemon-no-unused-vars': builtinRules.get('no-unused-vars'),
  },
};
