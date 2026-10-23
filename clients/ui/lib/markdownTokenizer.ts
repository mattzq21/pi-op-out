import { Lexer, Tokenizer, type HooksObject, type Token, type TokenizerObject } from "marked";

export class MarkdownLexer<ParserOutput = string, RendererOutput = string> extends Lexer<ParserOutput, RendererOutput> {
  emailFree = false;
  inlineTokens(source: string, tokens?: Token[]) {
    const previous = this.emailFree;
    this.emailFree = !source.includes("@");

    try { return super.inlineTokens(source, tokens); }
    finally { this.emailFree = previous; }
  }
}

export const markdownHooks: HooksObject = {
  provideLexer(block) {
    const isBlock = block ?? this.block;

    return (source, options) => {
      const lexer = new MarkdownLexer(options);

      return isBlock ? lexer.lex(source) : lexer.inlineTokens(source);
    };
  },
};

function emailFreeSource(lexer: Lexer, source: string) {
  if (lexer instanceof MarkdownLexer && lexer.emailFree) return true;

  return /^[\s\S]?[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]{64}/.test(source) && !source.includes("@");
}

class FirstLineRule extends RegExp {
  test(source: string) {
    const end = source.indexOf("\n");

    return super.test(end < 0 ? source : source.slice(0, end));
  }
}

const emailFreeRules = new WeakMap<RegExp, RegExp>();

const emailFreeRuleSets = new WeakMap<Tokenizer["rules"], Tokenizer["rules"]>();

function emailFreeText(rule: RegExp) {
  let result = emailFreeRules.get(rule);

  if (!result) {
    result = new RegExp(rule.source.replace(/\(\?=\[[^\]]+\]\+@\)/g, "(?!)"), rule.flags);
    emailFreeRules.set(rule, result);
  }

  return result;
}

function emailFreeRuleSet(rules: Tokenizer["rules"]) {
  let result = emailFreeRuleSets.get(rules);

  if (!result) {
    result = { ...rules, inline: { ...rules.inline, text: emailFreeText(rules.inline.text) } };
    emailFreeRuleSets.set(rules, result);
  }

  return result;
}

export const markdownTokenizer: TokenizerObject = {
  inlineText(source) {
    if (!emailFreeSource(this.lexer, source)) return false;
    const rules = this.rules;
    this.rules = emailFreeRuleSet(rules);

    try { return Tokenizer.prototype.inlineText.call(this, source); }
    finally { this.rules = rules; }
  },
  list(source) {
    if (!(this.rules.block.hr instanceof FirstLineRule)) {
      this.rules = { ...this.rules, block: { ...this.rules.block, hr: new FirstLineRule(this.rules.block.hr) } };
    }

    return Tokenizer.prototype.list.call(this, source);
  },
  url: source => /^(?:(?:https?|ftp):\/\/|www\.|[A-Za-z0-9._+-]+@)/i.test(source) ? false : undefined,
  hr: source => /^ {0,3}[-_*]/.test(source) ? false : undefined,
  blockquote: source => /^ {0,3}>/.test(source) ? false : undefined,
  html: source => /^ {0,3}</.test(source) ? false : undefined,
  table(source) {
    const newline = source.indexOf("\n");

    if (newline < 0) return undefined;
    const end = source.indexOf("\n", newline + 1);
    const separator = source.slice(newline + 1, end < 0 ? undefined : end);

    return /^ {0,3}(?:\| *)?:?-/.test(separator) ? false : undefined;
  },
  lheading(source) {
    const blank = /\n[ \t]*\n/.exec(source);
    const block = blank ? source.slice(0, blank.index + blank[0].length) : source;

    return /\n {0,3}(?:=+|-+) *(?:\n|$)/.test(block) ? false : undefined;
  },
};
