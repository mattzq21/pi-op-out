import noComments from './oxlint-no-comments.mjs';

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
  },
};
