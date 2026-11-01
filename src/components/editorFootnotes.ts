import { Node } from '@tiptap/core';

const definitionStart = /^ {0,3}\[\^[^\]\r\n]+\]:/;

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() { return { raw: { default: '', parseHTML: element => element.getAttribute('data-footnote-reference') } }; },
  parseHTML() { return [{ tag: 'span[data-footnote-reference]' }]; },
  renderHTML({ node }) { return ['span', { 'data-footnote-reference': node.attrs.raw, class: 'markdown-footnote-reference' }, node.attrs.raw]; },
  renderText({ node }) { return node.attrs.raw; },
  markdownTokenizer: {
    name: 'footnoteReference',
    level: 'inline',
    start: '[^',
    tokenize(source) {
      const match = /^\[\^[^\]\r\n]+\](?![\[(])/.exec(source);
      if (match) return { type: 'footnoteReference', raw: match[0] };
    },
  },
  parseMarkdown(token, helpers) { return helpers.createNode('footnoteReference', { raw: token.raw }); },
  renderMarkdown(node) { return node.attrs?.raw ?? ''; },
});

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  whitespace: 'pre',
  parseHTML() { return [{ tag: 'div[data-footnote-definition]', preserveWhitespace: 'full' }]; },
  renderHTML() { return ['div', { 'data-footnote-definition': '', class: 'markdown-footnote-definition' }, 0]; },
  markdownTokenizer: {
    name: 'footnoteDefinition',
    level: 'block',
    // Do not interrupt a paragraph: Marked's start hint omits its first
    // character, so it cannot reliably distinguish multiline inline code.
    // Adjacent definition text is kept literal by FootnoteReference instead.
    start: () => -1,
    tokenize(source, _tokens, lexer) {
      if (!definitionStart.test(source)) return;
      const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
      let raw = lines[0] ?? '';
      let index = 1;
      while (index < lines.length && lines[index]) {
        const line = lines[index];
        if (/^(?: {4}|\t)/.test(line)) { raw += line; index++; continue; }
        if (/^[ \t]*\n$/.test(line)) {
          let next = index + 1;
          while (next < lines.length && /^[ \t]*\n$/.test(lines[next])) next++;
          if (!/^(?: {4}|\t)/.test(lines[next] ?? '')) break;
          raw += lines.slice(index, next).join('');
          index = next;
          continue;
        }
        if (definitionStart.test(line) || !lexer.isParagraphContinuation?.(line.trimEnd())) break;
        raw += line;
        index++;
      }
      return { type: 'footnoteDefinition', raw, text: raw.replace(/\n$/, '') };
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode('footnoteDefinition', undefined, token.text ? [helpers.createTextNode(token.text)] : []);
  },
  // Keep the definition's Markdown body literal; normal text serialization
  // would escape its label and nested syntax, losing footnote semantics.
  renderMarkdown(node) { return node.content?.map(child => child.text ?? '').join('') ?? ''; },
});
