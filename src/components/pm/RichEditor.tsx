import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExt from "@tiptap/extension-link";
import ImageExt from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown as MarkdownExt } from "tiptap-markdown";
import {
  Type,
  ChevronDown,
  Bold,
  Italic,
  MoreHorizontal,
  List,
  ListOrdered,
  Plus,
  Link2,
  Image as ImageIcon,
  AtSign,
  Smile,
  Code2,
  Quote,
  Paperclip,
  HelpCircle,
  Strikethrough,
  Code,
  RemoveFormatting,
  Search,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { EmojiPicker } from "@/components/pm/EmojiPicker";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// RichEditor — Trello-style WYSIWYG comment/description editor (TipTap). The
// document is stored as Markdown, so everything that renders bodies (Markdown
// component, notifications, search) keeps working on plain text.
//
// Everything the editor opens (dropdowns, link/image forms, emoji picker, the
// caller's footer buttons) lives INSIDE the root element, so focus moving
// between them never counts as "leaving" — onLeave (autosave) fires only when
// focus goes somewhere outside the whole composer.
// -----------------------------------------------------------------------------

export interface MentionMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit?: () => void; // Ctrl/Cmd+Enter
  onLeave?: () => void; // focus left the composer → autosave
  placeholder?: string;
  autoFocus?: boolean;
  members?: MentionMember[];
  onAttachFiles?: (files: FileList) => void;
  menusUp?: boolean; // open dropdowns above (composer pinned at the bottom)
  footer?: ReactNode;
  className?: string;
}

type MenuKey = "heading" | "more" | "list" | "insert" | "emoji" | "link" | "image" | "help";

// Markdown escapes "_" — put mentions back to @user_name so the server-side
// @mention parser (regex on the body) still matches them.
const fixMentions = (md: string) => md.replace(/@[\w.\\-]+/g, (m) => m.replace(/\\_/g, "_"));

export function RichEditor({
  value,
  onChange,
  onSubmit,
  onLeave,
  placeholder = "Write a comment…",
  autoFocus,
  members = [],
  onAttachFiles,
  menusUp,
  footer,
  className,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuKey | null>(null);
  const [mention, setMention] = useState<{ query: string; from: number; index: number; left: number; top: number } | null>(null);

  // Latest callbacks / state for handlers created once inside the editor.
  const cb = useRef({ onChange, onSubmit, members, mention });
  cb.current = { onChange, onSubmit, members, mention };
  const lastEmitted = useRef(value);

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((m) => m.username.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, members]);
  const matchesRef = useRef(mentionMatches);
  matchesRef.current = mentionMatches;

  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      LinkExt.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      ImageExt,
      Placeholder.configure({ placeholder }),
      MarkdownExt.configure({ html: false, linkify: true, breaks: true, transformPastedText: true }),
      Extension.create({
        name: "composerKeys",
        addKeyboardShortcuts() {
          return {
            "Mod-Enter": () => {
              cb.current.onSubmit?.();
              return true;
            },
            "Mod-k": () => {
              setMenu("link");
              return true;
            },
          };
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const detectMention = (ed: Editor) => {
    const { selection } = ed.state;
    if (!selection.empty || cb.current.members.length === 0) return setMention(null);
    const $from = selection.$from;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, undefined, "￼");
    const m = before.match(/(?:^|\s)@([\w.-]*)$/);
    if (!m) return setMention(null);
    const at = selection.from - m[1].length - 1;
    const coords = ed.view.coordsAtPos(at);
    const box = rootRef.current?.getBoundingClientRect();
    setMention((prev) => ({
      query: m[1],
      from: at,
      index: prev && prev.from === at ? prev.index : 0,
      left: box ? coords.left - box.left : 0,
      top: box ? coords.bottom - box.top + 4 : 0,
    }));
  };

  const pickMention = (ed: Editor, username: string) => {
    const mm = cb.current.mention;
    if (!mm) return;
    ed.chain().focus().deleteRange({ from: mm.from, to: ed.state.selection.from }).insertContent(`@${username} `).run();
    setMention(null);
  };

  const editor = useEditor({
    extensions,
    content: value,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: "md outline-none px-3 py-2 min-h-[4.5rem] text-sm text-ink" },
      handleKeyDown: (_view, e) => {
        const mm = cb.current.mention;
        const list = matchesRef.current;
        if (!mm || list.length === 0) return false;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const d = e.key === "ArrowDown" ? 1 : -1;
          setMention({ ...mm, index: (mm.index + d + list.length) % list.length });
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (editorRef.current) pickMention(editorRef.current, list[mm.index]!.username);
          return true;
        }
        if (e.key === "Escape") {
          setMention(null);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = fixMentions((ed.storage.markdown as { getMarkdown: () => string }).getMarkdown());
      lastEmitted.current = md;
      cb.current.onChange(md);
      detectMention(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => detectMention(ed),
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // External value changes (draft cleared after send, reset on cancel).
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    editor.commands.setContent(value, false);
    lastEmitted.current = value;
  }, [value, editor]);

  // Close dropdowns on a click anywhere outside the composer.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  // When a dropdown holding the focused control unmounts (e.g. "+" search →
  // emoji picker), focus silently drops to <body> with no blur event — and then
  // a click away would never autosave. Snapshot "focus is inside" during render
  // (before the commit removes the node) and put the caret back afterwards.
  const focusWasInside = useRef(false);
  focusWasInside.current = !!rootRef.current && rootRef.current.contains(document.activeElement);
  useEffect(() => {
    const a = document.activeElement;
    if (focusWasInside.current && (!a || a === document.body)) editor?.view.focus(); // sync; commands.focus() waits a frame
  }, [menu, editor]);

  const onFocusOut = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && rootRef.current?.contains(to)) return;
    setMenu(null);
    setMention(null);
    onLeave?.();
  };

  const toggle = (k: MenuKey) => setMenu((m) => (m === k ? null : k));
  const run = (fn: (ed: Editor) => void) => {
    if (!editor) return;
    fn(editor);
    setMenu(null);
  };

  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const linkRange = useRef<{ from: number; to: number } | null>(null);
  const [imgUrl, setImgUrl] = useState("");
  const [insertQ, setInsertQ] = useState("");

  // Pre-fill the link form from the current selection when it opens.
  useEffect(() => {
    if (menu !== "link" || !editor) return;
    const { from, to } = editor.state.selection;
    linkRange.current = { from, to };
    setLinkText(editor.state.doc.textBetween(from, to, " "));
    setLinkUrl((editor.getAttributes("link").href as string | undefined) ?? "");
  }, [menu, editor]);

  const insertLink = () => {
    if (!editor || !linkUrl.trim()) return;
    let href = linkUrl.trim();
    if (!/^(https?:|mailto:)/i.test(href)) href = `https://${href}`;
    const r = linkRange.current ?? editor.state.selection;
    const text = linkText.trim() || href;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: r.from, to: r.to }, { type: "text", text, marks: [{ type: "link", attrs: { href } }] })
      .insertContent(" ")
      .run();
    setMenu(null);
    setLinkUrl("");
    setLinkText("");
  };

  const insertImage = () => {
    if (!editor || !/^https?:\/\//i.test(imgUrl.trim())) return;
    editor.chain().focus().setImage({ src: imgUrl.trim() }).run();
    setImgUrl("");
    setMenu(null);
  };

  const insertItems: { key: string; label: string; hint?: string; icon: ReactNode; kbd?: string; act: () => void }[] = [
    { key: "link", label: "Link", hint: "Insert a link", icon: <Link2 size={16} />, kbd: "Ctrl+K", act: () => setMenu("link") },
    { key: "image", label: "Image", hint: "Embed an image by URL", icon: <ImageIcon size={16} />, act: () => setMenu("image") },
    {
      key: "mention",
      label: "Mention",
      hint: "Mention someone to send them a notification",
      icon: <AtSign size={16} />,
      kbd: "@",
      act: () => run((ed) => ed.chain().focus().insertContent(" @").run()),
    },
    { key: "emoji", label: "Emoji", hint: "Use emojis to express ideas and emotions", icon: <Smile size={16} />, act: () => setMenu("emoji") },
    {
      key: "code",
      label: "Code snippet",
      hint: "Display code in a monospace block",
      icon: <Code2 size={16} />,
      kbd: "```",
      act: () => run((ed) => ed.chain().focus().toggleCodeBlock().run()),
    },
    {
      key: "quote",
      label: "Quote",
      hint: "Insert a quote or citation",
      icon: <Quote size={16} />,
      kbd: ">",
      act: () => run((ed) => ed.chain().focus().toggleBlockquote().run()),
    },
  ];
  const insertShown = insertItems.filter((i) => i.label.toLowerCase().includes(insertQ.trim().toLowerCase()));

  const headingLabel = (() => {
    if (!editor) return null;
    for (let l = 1; l <= 6; l++) if (editor.isActive("heading", { level: l })) return `H${l}`;
    return null;
  })();

  return (
    <div
      ref={rootRef}
      data-composer
      onBlur={onFocusOut}
      className={cn(
        "relative rounded-md border border-rule bg-inset transition-colors focus-within:border-accent focus-within:bg-surface",
        className,
      )}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-line px-1.5 py-1 flex-wrap">
        <div className="relative">
          <TB title="Text styles" active={menu === "heading"} onClick={() => toggle("heading")}>
            {headingLabel ? <span className="text-xs font-bold w-4">{headingLabel}</span> : <Type size={15} />}
            <ChevronDown size={12} />
          </TB>
          <Drop open={menu === "heading"} up={menusUp} className="w-60">
            <DropItem onClick={() => run((ed) => ed.chain().focus().setParagraph().run())} kbd="Ctrl+Alt+0" active={editor?.isActive("paragraph")}>
              Normal text
            </DropItem>
            {([1, 2, 3, 4, 5, 6] as const).map((l) => (
              <DropItem
                key={l}
                kbd={`Ctrl+Alt+${l}`}
                active={editor?.isActive("heading", { level: l })}
                onClick={() => run((ed) => ed.chain().focus().toggleHeading({ level: l }).run())}
              >
                <span className={cn("font-bold", ["text-xl", "text-lg", "text-base", "text-sm", "text-xs", "text-[11px]"][l - 1])}>
                  Heading {l}
                </span>
              </DropItem>
            ))}
          </Drop>
        </div>

        <Sep />
        <TB title="Bold (Ctrl+B)" active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <Bold size={15} />
        </TB>
        <TB title="Italic (Ctrl+I)" active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <Italic size={15} />
        </TB>
        <div className="relative">
          <TB title="More formatting" active={menu === "more"} onClick={() => toggle("more")}>
            <MoreHorizontal size={15} />
          </TB>
          <Drop open={menu === "more"} up={menusUp} className="w-56">
            <DropItem icon={<Strikethrough size={14} />} kbd="Ctrl+Shift+S" active={editor?.isActive("strike")} onClick={() => run((ed) => ed.chain().focus().toggleStrike().run())}>
              Strikethrough
            </DropItem>
            <DropItem icon={<Code size={14} />} kbd="Ctrl+E" active={editor?.isActive("code")} onClick={() => run((ed) => ed.chain().focus().toggleCode().run())}>
              Inline code
            </DropItem>
            <DropItem icon={<RemoveFormatting size={14} />} onClick={() => run((ed) => ed.chain().focus().unsetAllMarks().clearNodes().run())}>
              Clear formatting
            </DropItem>
          </Drop>
        </div>

        <Sep />
        <div className="relative">
          <TB title="Lists" active={menu === "list"} onClick={() => toggle("list")}>
            {editor?.isActive("orderedList") ? <ListOrdered size={15} /> : <List size={15} />}
            <ChevronDown size={12} />
          </TB>
          <Drop open={menu === "list"} up={menusUp} className="w-60">
            <DropItem icon={<List size={14} />} kbd="Ctrl+Shift+8" active={editor?.isActive("bulletList")} onClick={() => run((ed) => ed.chain().focus().toggleBulletList().run())}>
              Bullet list
            </DropItem>
            <DropItem icon={<ListOrdered size={14} />} kbd="Ctrl+Shift+7" active={editor?.isActive("orderedList")} onClick={() => run((ed) => ed.chain().focus().toggleOrderedList().run())}>
              Numbered list
            </DropItem>
          </Drop>
        </div>

        <Sep />
        <div className="relative">
          <TB
            title="Insert"
            active={menu === "insert" || menu === "link" || menu === "image" || menu === "emoji"}
            onClick={() => {
              setInsertQ("");
              toggle("insert");
            }}
          >
            <Plus size={15} />
            <ChevronDown size={12} />
          </TB>
          <Drop open={menu === "insert"} up={menusUp} className="w-80">
            <div className="px-2 pt-1 pb-1.5">
              <div className="flex items-center gap-2 rounded-md border border-rule bg-inset px-2 h-8 focus-within:border-accent">
                <Search size={13} className="text-subtle shrink-0" />
                <input
                  autoFocus
                  value={insertQ}
                  onChange={(e) => setInsertQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && insertShown[0]) {
                      e.preventDefault();
                      insertShown[0].act();
                    }
                    if (e.key === "Escape") {
                      setMenu(null);
                      editor?.commands.focus();
                    }
                  }}
                  placeholder="Search"
                  className="flex-1 min-w-0 bg-transparent outline-none text-sm text-ink placeholder:text-subtle"
                />
              </div>
            </div>
            {insertShown.map((i) => (
              <button
                key={i.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={i.act}
                className="w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-inset transition-colors"
              >
                <span className="grid place-items-center w-8 h-8 shrink-0 rounded-md border border-border bg-inset text-muted">{i.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-ink">{i.label}</span>
                  {i.hint && <span className="block text-xs text-subtle">{i.hint}</span>}
                </span>
                {i.kbd && <Kbd>{i.kbd}</Kbd>}
              </button>
            ))}
            {insertShown.length === 0 && <div className="px-3 py-2 text-sm text-subtle">No matches.</div>}
          </Drop>

          <Drop open={menu === "link"} up={menusUp} className="w-72 p-3 space-y-2">
            <label className="block text-xs font-semibold text-subtle">Link</label>
            <input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  insertLink();
                }
              }}
              placeholder="Paste or type a link"
              className="w-full rounded-md border border-rule bg-inset px-2 h-8 text-sm text-ink outline-none focus:border-accent"
            />
            <label className="block text-xs font-semibold text-subtle">Display text (optional)</label>
            <input
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  insertLink();
                }
              }}
              placeholder="Text to show"
              className="w-full rounded-md border border-rule bg-inset px-2 h-8 text-sm text-ink outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2 pt-1">
              <SmallBtn onClick={() => setMenu(null)}>Cancel</SmallBtn>
              <SmallBtn primary disabled={!linkUrl.trim()} onClick={insertLink}>
                Insert
              </SmallBtn>
            </div>
          </Drop>

          <Drop open={menu === "image"} up={menusUp} className="w-72 p-3 space-y-2">
            <label className="block text-xs font-semibold text-subtle">Image URL</label>
            <input
              autoFocus
              value={imgUrl}
              onChange={(e) => setImgUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  insertImage();
                }
              }}
              placeholder="https://…/image.png"
              className="w-full rounded-md border border-rule bg-inset px-2 h-8 text-sm text-ink outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2 pt-1">
              <SmallBtn onClick={() => setMenu(null)}>Cancel</SmallBtn>
              <SmallBtn primary disabled={!/^https?:\/\//i.test(imgUrl.trim())} onClick={insertImage}>
                Insert
              </SmallBtn>
            </div>
          </Drop>

          <Drop open={menu === "emoji"} up={menusUp} className="p-0 overflow-hidden">
            <EmojiPicker
              onPick={(emo) => {
                editor?.chain().focus().insertContent(emo).run();
                setMenu(null);
              }}
            />
          </Drop>
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          {onAttachFiles && (
            <>
              <TB title="Attach a file to this card" onClick={() => fileRef.current?.click()}>
                <Paperclip size={15} />
              </TB>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) onAttachFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <div className="relative">
            <TB title="Formatting help" active={menu === "help"} onClick={() => toggle("help")}>
              <HelpCircle size={15} />
            </TB>
            <Drop open={menu === "help"} up={menusUp} align="right" className="w-64 p-3 text-xs text-muted space-y-1.5">
              <div className="text-sm font-semibold text-ink mb-1">Shortcuts</div>
              {[
                ["Bold", "Ctrl+B"],
                ["Italic", "Ctrl+I"],
                ["Link", "Ctrl+K"],
                ["Heading 1–6", "Ctrl+Alt+1–6"],
                ["Bullet list", "Ctrl+Shift+8 or - "],
                ["Numbered list", "Ctrl+Shift+7 or 1. "],
                ["Quote", "> "],
                ["Code block", "``` "],
                ["Mention", "@"],
                ["Save", "Ctrl+Enter"],
              ].map(([a, b]) => (
                <div key={a} className="flex justify-between gap-3">
                  <span>{a}</span>
                  <Kbd>{b}</Kbd>
                </div>
              ))}
            </Drop>
          </div>
        </div>
      </div>

      <EditorContent editor={editor} />

      {/* @mention suggestions, anchored under the "@" */}
      {mention && mentionMatches.length > 0 && editor && (
        <div
          className="absolute z-30 w-60 rounded-md border border-border bg-surface shadow-pop py-1"
          style={{ left: Math.max(0, Math.min(mention.left, (rootRef.current?.clientWidth ?? 240) - 240)), top: mention.top }}
        >
          {mentionMatches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickMention(editor, m.username)}
              className={cn("w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm", i === mention.index ? "bg-inset" : "hover:bg-inset")}
            >
              <Avatar name={m.display_name} src={m.avatar_url} size={22} />
              <span className="flex-1 min-w-0 truncate text-ink">{m.display_name}</span>
              <span className="text-xs text-subtle">@{m.username}</span>
            </button>
          ))}
        </div>
      )}

      {footer && <div className="px-2 pb-2">{footer}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ bits ---

function TB({ children, onClick, active, title }: { children: ReactNode; onClick: () => void; active?: boolean; title: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()} // keep the caret in the editor
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-0.5 h-7 px-1.5 rounded text-muted transition-colors",
        active ? "bg-accent-soft text-accent" : "hover:bg-inset hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-line" />;
}

function Drop({
  open,
  up,
  align = "left",
  className,
  children,
}: {
  open: boolean;
  up?: boolean;
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className={cn(
        "absolute z-30 rounded-md border border-border bg-surface shadow-pop py-1",
        up ? "bottom-full mb-1" : "top-full mt-1",
        align === "right" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function DropItem({
  children,
  onClick,
  kbd,
  icon,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  kbd?: string;
  icon?: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-ink transition-colors", active ? "bg-accent-soft" : "hover:bg-inset")}
    >
      {icon && <span className="text-muted">{icon}</span>}
      <span className="flex-1 min-w-0">{children}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded bg-inset border border-line px-1.5 py-0.5 text-[10px] font-medium text-subtle">{children}</span>;
}

function SmallBtn({ children, onClick, primary, disabled }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "h-7 px-2.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50",
        primary ? "bg-accent text-white hover:bg-accent-hover" : "text-muted hover:bg-inset hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
