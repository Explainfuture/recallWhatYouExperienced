import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { createMarkdownExtensions } from './editorExtensions';
import './markdown.css';

interface MarkdownEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

export default function MarkdownEditor({ id, label, value, onChange, disabled = false, autoFocus = false }: MarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const lastValue = useRef(value);
  onChangeRef.current = onChange;
  const extensions = useMemo(createMarkdownExtensions, []);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { id, class: 'markdown-content markdown-live-editor', role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false' },
      handleClick(_view, _position, event) {
        // A link remains editable here; saved entries handle opening URLs.
        if ((event.target as Element | null)?.closest('a')) { event.preventDefault(); return true; }
        return false;
      },
    },
    onUpdate({ editor: updated }) {
      const markdown = updated.getMarkdown();
      lastValue.current = markdown;
      onChangeRef.current(markdown);
    },
  }, [id]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    // Parent updates caused by typing never reset the document or selection.
    // Only a different external draft is loaded, preserving IME and undo history.
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);

  return <div className="markdown-editor markdown-editor-live" aria-disabled={disabled}>
    <EditorContent editor={editor} />
  </div>;
}
