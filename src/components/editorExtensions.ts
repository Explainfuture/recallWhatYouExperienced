import { Extension, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { FootnoteDefinition, FootnoteReference } from './editorFootnotes';

const markdownPattern = /(^|\n)\s{0,3}(?:#{1,6}\s|>\s|[-+*]\s|\d+\.\s|`{3}|~{3}|\|)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|!?\[[^\]]*\]\([^\n]+\)|`[^`\n]+`/;

const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  priority: 1100,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
        handlePaste(view, event) {
          const text = event.clipboardData?.getData('text/plain');
          if (!text || view.state.selection.$from.parent.type.spec.code) return false;
          const html = event.clipboardData?.getData('text/html');
          if (html && !markdownPattern.test(text)) return false;
          // Keep a Markdown paste in one transaction so undo restores its insertion.
          event.preventDefault();
          return editor.commands.insertContent(text, { contentType: 'markdown' });
        },
      },
    })];
  },
});

const SafeImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const source = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
    if (!/^https?:\/\//i.test(source)) return ['span', { class: 'markdown-image-placeholder' }, HTMLAttributes.alt || '图片'];
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })];
  },
});

export function createMarkdownExtensions() {
  return [
    MarkdownPaste,
    FootnoteReference,
    FootnoteDefinition,
    StarterKit.configure({
      underline: false,
      link: {
        openOnClick: false,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
        isAllowedUri: (url, context) => context.defaultValidate(url) && (/^(https?:|mailto:)/i.test(url) || url.startsWith('#')),
      },
    }),
    TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
    TaskList,
    TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node) => `任务：${node.textContent || '未命名'}` } }),
    SafeImage.configure({ inline: true }),
    Placeholder.configure({ placeholder: '写下你的思考…' }),
    Markdown.configure({ markedOptions: { gfm: true }, indentation: { style: 'space', size: 2 } }),
  ];
}
