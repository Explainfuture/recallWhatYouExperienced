import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { createMarkdownExtensions } from './editorExtensions';

const markdown = new MarkdownManager({ extensions: createMarkdownExtensions(), markedOptions: { gfm: true } });

describe('footnote preservation', () => {
  it('keeps references and multiline definitions after an ordinary body edit', () => {
    const source = '正文[^a] 与[^b]\n\n[^a]: 第一行 **粗体**\n    延续正文\n\n    第二段与 [链接](https://example.com)\n\n[^b]: 第二条\n\n结尾';
    const document = markdown.parse(source);
    document.content![0].content![0].text = '修改后的正文';
    const saved = markdown.serialize(document);
    expect(saved).toBe(source.replace('正文[^a]', '修改后的正文[^a]'));
    expect(markdown.parse(saved)).toEqual(document);
    const adjacent = '正文[^a]\n[^a]: 没有空行的定义\n延续正文';
    expect(markdown.serialize(markdown.parse(adjacent))).toBe(adjacent);
  });

  it('does not parse definition-shaped text inside inline, fenced, or indented code', () => {
    const source = '正文[^a]\n\n`[^fake]`\n\n`line\n[^fake]: literal\nend`\n\n```md\n[^fake]: inside fence\n```\n\n    [^fake]: indented code\n\n[^a]: 真实定义\n\n结尾';
    const document = markdown.parse(source);
    expect(document.content!.filter(node => node.type === 'footnoteDefinition')).toHaveLength(1);
    expect(document.content![2].content![0]).toMatchObject({ text: 'line [^fake]: literal end', marks: [{ type: 'code' }] });
    expect(document.content![3].content![0].text).toBe('[^fake]: inside fence');
    expect(document.content![4].content![0].text).toBe('[^fake]: indented code');
    expect(markdown.parse(markdown.serialize(document))).toEqual(document);
  });

  it('preserves normal links and images using caret labels', () => {
    const source = '[^a](https://example.com) 与 ![^a](https://example.com/p.png)\n\n[^a]: 定义\n\n结尾';
    const document = markdown.parse(source);
    expect(document.content![0].content![0].marks?.[0]).toMatchObject({ type: 'link', attrs: { href: 'https://example.com' } });
    expect(document.content![0].content![2]).toMatchObject({ type: 'image', attrs: { alt: '^a' } });
    expect(markdown.serialize(document)).toBe(source);
  });
});
