import { isLintDirective, licenseHeaderComments } from './comment-policy.mjs';

const noComments = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { forbidden: 'Comments are not allowed except license headers, lint directives, and shebangs.' },
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode;
        const comments = source.getAllComments().filter((comment) => comment.type !== 'Shebang');
        const licenses = licenseHeaderComments(source.text, comments);

        for (const comment of comments) {
          if (licenses.has(comment) || isLintDirective(comment.value)) continue;

          context.report({ loc: comment.loc, messageId: 'forbidden' });
        }
      },
    };
  },
};

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
