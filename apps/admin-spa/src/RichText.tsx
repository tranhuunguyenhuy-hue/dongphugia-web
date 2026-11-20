// Rich-text editor for blog content (TipTap, same extensions/config as the legacy Admin editor). Loaded lazily:
// only the blog form pays for the editor bundle. The parent mounts it AFTER the row has loaded, so `value` is the
// initial document and later edits flow one way (editor -> onChange).
import { useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Button } from '@/components/ui/button'
import { displayMediaUrl, errorText, uploadImage } from './api'

// Show legacy-host images through the verified default host WITHOUT changing the stored document attribute.
const DisplayImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('img')
      dom.src = displayMediaUrl(node.attrs.src)
      if (node.attrs.alt) dom.alt = String(node.attrs.alt)
      if (node.attrs.title) dom.title = String(node.attrs.title)
      return { dom }
    }
  },
})

export default function RichText({ value, onChange, disabled, folder = 'blog' }: { value: string; onChange: (html: string) => void; disabled?: boolean; folder?: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const editor = useEditor({
    extensions: [StarterKit, DisplayImage.configure({ inline: false, allowBase64: false }), Link.configure({ openOnClick: false, autolink: true }), Placeholder.configure({ placeholder: 'Bắt đầu viết nội dung...' })],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: { attributes: { class: 'prose', 'aria-label': 'Nội dung bài viết' } },
    immediatelyRender: false,
  })
  if (!editor) return <p className="text-sm text-muted-foreground">Đang tải trình soạn thảo…</p>
  const run = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); fn() }
  const btn = (label: string, title: string, action: () => void, active = false) => (
    <Button type="button" size="xs" variant={active ? 'secondary' : 'ghost'} title={title} aria-pressed={active} disabled={disabled} onClick={run(action)}>{label}</Button>
  )
  return (
    <div className="overflow-hidden rounded-md border border-input bg-background">
      {!disabled && (
        <div className="flex flex-wrap gap-1 border-b bg-muted/40 p-1.5" role="toolbar" aria-label="Định dạng">
          {btn('B', 'Đậm', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
          {btn('I', 'Nghiêng', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
          {btn('S', 'Gạch ngang', () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}
          {btn('</>', 'Mã', () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
          {btn('H2', 'Tiêu đề 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
          {btn('H3', 'Tiêu đề 3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
          {btn('• Danh sách', 'Danh sách', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
          {btn('1. Danh sách', 'Danh sách số', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
          {btn('“ ”', 'Trích dẫn', () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
          {btn('―', 'Đường kẻ', () => editor.chain().focus().setHorizontalRule().run())}
          {btn('Liên kết', 'Liên kết', () => {
            const previous = editor.getAttributes('link').href || ''
            const url = window.prompt('URL liên kết (https://…):', previous)
            if (url === null) return
            if (url === '') editor.chain().focus().extendMarkRange('link').unsetLink().run()
            else if (/^(https?:\/\/|\/|mailto:|tel:)/i.test(url)) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
            else setError('Liên kết phải bắt đầu bằng https://, /, mailto: hoặc tel:.')
          }, editor.isActive('link'))}
          {btn(busy ? 'Đang tải…' : 'Ảnh', 'Chèn ảnh', () => picker.current?.click())}
          {btn('↶', 'Hoàn tác', () => editor.chain().focus().undo().run())}
          {btn('↷', 'Làm lại', () => editor.chain().focus().redo().run())}
          <input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={async (e) => {
            const file = e.target.files?.[0]; e.target.value = ''
            if (!file) return
            if (file.size > 5 * 1024 * 1024) { setError('Ảnh quá lớn (tối đa 5MB).'); return }
            setBusy(true); setError('')
            try { editor.chain().focus().setImage({ src: await uploadImage(file, folder, 'editorial') }).run() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
          }} />
        </div>
      )}
      <EditorContent editor={editor} className="[&_.prose]:min-h-72 [&_.prose]:px-4 [&_.prose]:py-3 [&_.prose]:text-sm [&_.prose]:outline-none [&_.prose_a]:text-primary [&_.prose_a]:underline [&_.prose_blockquote]:border-l-2 [&_.prose_blockquote]:pl-3 [&_.prose_blockquote]:text-muted-foreground [&_.prose_code]:rounded [&_.prose_code]:bg-muted [&_.prose_code]:px-1 [&_.prose_h2]:mt-4 [&_.prose_h2]:mb-2 [&_.prose_h2]:text-xl [&_.prose_h2]:font-semibold [&_.prose_h3]:mt-3 [&_.prose_h3]:mb-1.5 [&_.prose_h3]:text-lg [&_.prose_h3]:font-semibold [&_.prose_hr]:my-4 [&_.prose_img]:h-auto [&_.prose_img]:max-w-full [&_.prose_img]:rounded-md [&_.prose_ol]:list-decimal [&_.prose_ol]:pl-6 [&_.prose_p]:my-2 [&_.prose_p.is-editor-empty:first-child::before]:pointer-events-none [&_.prose_p.is-editor-empty:first-child::before]:float-left [&_.prose_p.is-editor-empty:first-child::before]:h-0 [&_.prose_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.prose_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.prose_ul]:list-disc [&_.prose_ul]:pl-6" />
      {error && <p role="alert" className="border-t px-3 py-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}
