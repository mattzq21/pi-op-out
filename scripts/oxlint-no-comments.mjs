import { isLintDirective, licenseHeaderComments } from './comment-policy.mjs';

export default {
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
