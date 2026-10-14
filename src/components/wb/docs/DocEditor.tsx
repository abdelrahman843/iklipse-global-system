import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import LinkExt from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  Bold,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  Code,
  Code2,
  Eye,
  FileText,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { Spinner, PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useWb, commit, mergeItem, peerColor } from "@/lib/wb/store";
import { DocSession, DOC_FIELD, type DocSaveState, type DocStatus } from "@/lib/wb/docSync";
import { blocksFromDoc, docTitle } from "@/lib/wb/docBlocks";
import { useWbPeople, type WbPerson } from "@/lib/wb/people";
import { supabase } from "@/lib/supabase";
import { DocImage, docMention, insertDocImages, type MentionMenu } from "./docExtensions";

// -----------------------------------------------------------------------------
// Miro Docs: a doc on the board opens full screen as a page. Everyone with edit
// rights types into it at once (Yjs, see docSync.ts); viewers read along live.
// The canvas shows a preview the editors keep up to date.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const PREVIEW_EVERY = 1200;

export default function DocEditor({ docId, onClose }: { docId: string; onClose: () => void }) {
  const { user, profile } = useAuth();
  const item = useWb((s) => s.items[docId]);
  const boardId = useWb((s) => s.boardId);
  const canEdit = useWb((s) => s.canEdit);
  const [status, setStatus] = useState<DocStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<DocSaveState>("saved");
  const [session, setSession] = useState<DocSession | null>(null);
  const exists = !!item;

  // One session per open doc (and per edit right: viewers don't send).
  useEffect(() => {
    if (!boardId || !user || !exists) return;
    const it = S().items[docId];
    const copyOf = Array.isArray(it?.data.copyOf) ? (it!.data.copyOf as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    const ses = new DocSession({
      boardId,
      docId,
      canEdit,
      copyOf,
      user: { name: profile?.display_name ?? "Someone", color: peerColor(user.id) },
      onStatus: (st, err) => {
        setStatus(st);
        setError(err ?? null);
      },
      onSave: setSaveState,
    });
    setSession(ses);
    setStatus("loading");
    return () => {
      void ses.close();
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, docId, canEdit, user?.id, exists]);

  // The doc was deleted (here or by someone else).
  useEffect(() => {
    if (!exists && S().loaded) onClose();
  }, [exists, onClose]);

  // Unsaved typing: hold the tab.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (session?.pending) e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [session]);

  return (
    <div
      data-wb-ui
      role="dialog"
      aria-modal="true"
      aria-label={item ? docTitle(item) : "Doc"}
      className="fixed inset-0 z-50 flex flex-col bg-bg animate-fade-in"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Esc that closed a picker inside the editor (mentions) doesn't close the doc.
        if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="menu"]')) onClose();
      }}
    >
      {session && status === "ready" && item ? (
        <DocBody key={`${docId}:${canEdit}`} session={session} docId={docId} canEdit={canEdit} saveState={saveState} onClose={onClose} />
      ) : (
        <>
          <Header docId={docId} canEdit={canEdit} saveState="saved" onClose={onClose} people={[]} />
          <div className="flex-1 grid place-items-center">
            {status === "error" ? (
              <div className="text-center px-6">
                <CloudOff size={28} className="mx-auto text-subtle" />
                <p className="mt-3 text-sm font-medium text-ink">Couldn't open this doc</p>
                {error && <p className="mt-1 text-sm text-muted">{error}</p>}
              </div>
            ) : (
              <PageSpinner />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ body --
function DocBody({
  session,
  docId,
  canEdit,
  saveState,
  onClose,
}: {
  session: DocSession;
  docId: string;
  canEdit: boolean;
  saveState: DocSaveState;
  onClose: () => void;
}) {
  const canCopy = useWb((s) => s.canCopy);
  const boardId = useWb((s) => s.boardId);
  const toast = useToast();
  const people = useAwarenessPeople(session);
  const everyone = useWbPeople();
  const peopleRef = useRef<WbPerson[]>([]);
  peopleRef.current = everyone.data?.list ?? [];
  const [mention, setMention] = useState<MentionMenu | null>(null);
  const [uploading, setUploading] = useState(0);
  const onBusy = (d: number) => setUploading((n) => Math.max(0, n + d));
  const onUploadError = (msg: string) => toast.push({ kind: "error", title: "Couldn't add image", description: msg });
  const helpers = useRef({ onBusy, onUploadError });
  helpers.current = { onBusy, onUploadError };

  // Tell the person mentioned (the server checks they can see the board). The
  // line is read a few seconds later so the message has the whole sentence.
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>());
  const notify = (p: WbPerson, ed: Editor) => {
    const boardNow = S().boardId;
    if (!boardNow) return;
    const at = ed.state.selection.$from.before();
    const lineText = () => {
      const node = ed.isDestroyed ? null : ed.state.doc.nodeAt(Math.min(at, ed.state.doc.content.size - 1));
      if (!node || !node.isTextblock) return "";
      return node.textBetween(0, node.content.size, " ", (leaf) => (leaf.type.name === "mention" ? `@${leaf.attrs.label ?? ""}` : ""));
    };
    let text = lineText();
    const send = () => {
      pending.current.delete(p.id);
      void supabase
        .rpc("wb_doc_mention", { p_board: boardNow, p_doc: docId, p_user: p.id, p_excerpt: text.slice(0, 300) })
        .then(({ error }) => error && console.warn("Mention notification skipped", error.message));
    };
    const prev = pending.current.get(p.id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      text = lineText() || text;
      send();
    }, 4000);
    pending.current.set(p.id, {
      timer,
      send: () => {
        clearTimeout(timer);
        text = lineText() || text;
        send();
      },
    });
  };
  // Closing the doc sends what's waiting.
  useEffect(() => {
    const map = pending.current;
    return () => {
      for (const v of [...map.values()]) v.send();
    };
  }, []);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const lastBlocks = useRef<string>(JSON.stringify(S().items[docId]?.data.blocks ?? []));
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writePreview = (ed: Editor) => {
    previewTimer.current = null;
    if (!S().canEdit || ed.isDestroyed) return;
    const blocks = blocksFromDoc(ed.getJSON());
    const json = JSON.stringify(blocks);
    if (json === lastBlocks.current) return;
    lastBlocks.current = json;
    const it = S().items[docId];
    // The preview follows the text; it isn't a canvas edit of its own to undo.
    if (it) commit({ [docId]: mergeItem(it, { data: { blocks } }) }, { history: false });
  };

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        StarterKit.configure({ history: false, heading: { levels: [1, 2, 3] } }),
        Underline,
        LinkExt.configure({ openOnClick: !canEdit, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } }),
        Placeholder.configure({ placeholder: canEdit ? "Start writing, or type a heading…" : "" }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Highlight,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        DocImage,
        docMention({ people: () => peopleRef.current, show: setMention, picked: (p, ed) => notifyRef.current(p, ed) }),
        Collaboration.configure({ document: session.ydoc, field: DOC_FIELD }),
        CollaborationCursor.configure({
          provider: { awareness: session.awareness },
          user: session.awareness.getLocalState()?.user as { name: string; color: string },
        }),
      ],
      editorProps: {
        attributes: { class: "wb-doc outline-none min-h-[60vh]", spellcheck: "true" },
        // Pasted or dropped image files are uploaded into the board's folder.
        handlePaste: (_view, e) => {
          const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length || !S().canEdit || !S().boardId || !editorRef.current) return false;
          e.preventDefault();
          void insertDocImages(editorRef.current, S().boardId!, files, helpers.current.onUploadError, helpers.current.onBusy);
          return true;
        },
        handleDrop: (view, e, _slice, moved) => {
          const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (moved || !files.length || !S().canEdit || !S().boardId || !editorRef.current) return false;
          e.preventDefault();
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
          void insertDocImages(editorRef.current, S().boardId!, files, helpers.current.onUploadError, helpers.current.onBusy, at);
          return true;
        },
        handleDOMEvents: {
          // Viewers barred from copying (share settings) can't take the text either.
          copy: (_v, e) => {
            if (S().canCopy) return false;
            e.preventDefault();
            return true;
          },
          cut: (_v, e) => {
            if (S().canCopy) return false;
            e.preventDefault();
            return true;
          },
        },
      },
      onUpdate: ({ editor: ed }) => {
        if (!previewTimer.current) previewTimer.current = setTimeout(() => writePreview(ed), PREVIEW_EVERY);
      },
    },
    [session, canEdit],
  );

  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // Leaving: write the latest preview right away.
  useEffect(
    () => () => {
      if (previewTimer.current) {
        clearTimeout(previewTimer.current);
        if (editor) writePreview(editor);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );

  // A brand-new doc: put the caret in it.
  useEffect(() => {
    if (editor && canEdit && editor.isEmpty) editor.commands.focus("end");
  }, [editor, canEdit]);

  return (
    <>
      <Header docId={docId} canEdit={canEdit} saveState={saveState} onClose={onClose} people={people} />
      {canEdit && editor && (
        <Toolbar
          editor={editor}
          uploading={uploading}
          onImages={(files) => boardId && void insertDocImages(editor, boardId, files, onUploadError, onBusy)}
        />
      )}
      {mention && mention.rect && <MentionPicker menu={mention} />}
      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" onClick={(e) => e.target === e.currentTarget && editor?.commands.focus("end")}>
        <div
          className={cn(
            "mx-auto my-4 sm:my-8 w-[min(816px,calc(100%-24px))] bg-surface border border-border rounded-lg shadow-card px-5 sm:px-14 py-8 sm:py-12",
            !canCopy && "select-none",
          )}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- header --
interface DocPerson {
  id: number;
  name: string;
  color: string;
}

function useAwarenessPeople(session: DocSession): DocPerson[] {
  const [people, setPeople] = useState<DocPerson[]>([]);
  useEffect(() => {
    const aw = session.awareness;
    const read = () => {
      const out: DocPerson[] = [];
      aw.getStates().forEach((st, id) => {
        const u = (st as { user?: { name?: unknown; color?: unknown } }).user;
        if (id === aw.clientID || !u || typeof u.name !== "string") return;
        out.push({ id, name: u.name, color: typeof u.color === "string" ? u.color : "#579dff" });
      });
      setPeople(out);
    };
    read();
    aw.on("change", read);
    return () => aw.off("change", read);
  }, [session]);
  return people;
}

function Header({
  docId,
  canEdit,
  saveState,
  onClose,
  people,
}: {
  docId: string;
  canEdit: boolean;
  saveState: DocSaveState;
  onClose: () => void;
  people: DocPerson[];
}) {
  const toast = useToast();
  const item = useWb((s) => s.items[docId]);
  const boardId = useWb((s) => s.boardId);
  const title = item ? docTitle(item) : "Doc";
  const stored = typeof item?.data.title === "string" ? item.data.title : "";
  const [draft, setDraft] = useState(stored);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(stored);
  }, [stored]);

  const saveTitle = (t: string) => {
    const it = S().items[docId];
    if (!it) return;
    commit({ [docId]: mergeItem(it, { data: { title: t.slice(0, 200) || undefined } }) }, { key: `doc-title:${docId}` });
  };

  // One avatar per person (two tabs share one).
  const shown = useMemo(() => {
    const seen = new Set<string>();
    return people.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
  }, [people]);

  return (
    <header className="shrink-0 h-14 flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 bg-surface border-b border-border shadow-card pt-[env(safe-area-inset-top)] box-content">
      <button
        onClick={onClose}
        className="h-9 shrink-0 inline-flex items-center gap-1.5 px-2 rounded-md text-sm text-muted hover:bg-inset hover:text-ink"
        title="Back to board (Esc)"
      >
        <ArrowLeft size={17} />
        <span className="hidden sm:inline">Board</span>
      </button>
      <span className="h-6 w-px bg-line shrink-0" />
      <FileText size={18} className="text-accent shrink-0 ml-1" />
      {canEdit ? (
        <input
          value={draft}
          placeholder="Untitled doc"
          maxLength={200}
          aria-label="Doc title"
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setDraft(e.target.value);
            saveTitle(e.target.value);
          }}
          onBlur={() => {
            focused.current = false;
            const t = draft.trim();
            if (t !== draft) saveTitle(t);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 h-9 px-2 rounded-md bg-transparent text-ink font-semibold text-lg sm:text-base outline-none hover:bg-inset focus:bg-inset placeholder:text-subtle"
        />
      ) : (
        <h1 className="min-w-0 flex-1 truncate px-2 text-ink font-semibold text-base">{title}</h1>
      )}

      {!canEdit && (
        <span className="hidden sm:inline-flex shrink-0 items-center gap-1.5 h-7 px-2.5 rounded-full bg-inset text-xs text-ink">
          <Eye size={13} className="text-accent" /> View only
        </span>
      )}

      {shown.length > 0 && (
        <div className="flex items-center -space-x-1.5 shrink-0 pl-1" aria-label={`${shown.length} editing`}>
          {shown.slice(0, 4).map((p) => (
            <span key={p.id} className="rounded-full block" style={{ boxShadow: `0 0 0 2px ${p.color}` }} title={p.name}>
              <Avatar name={p.name} size={26} />
            </span>
          ))}
          {shown.length > 4 && <span className="h-6 min-w-6 px-1 rounded-full bg-inset text-[11px] text-ink grid place-items-center ring-2 ring-surface">+{shown.length - 4}</span>}
        </div>
      )}

      {canEdit && (
        <span
          className="shrink-0 hidden sm:grid place-items-center h-9 w-7 text-subtle"
          title={saveState === "offline" ? "Offline: your changes will save when you're back online" : saveState === "saving" ? "Saving" : "All changes saved"}
        >
          {saveState === "offline" ? <CloudOff size={15} className="text-danger" /> : saveState === "saving" ? <Cloud size={15} className="animate-pulse" /> : <Check size={15} />}
        </span>
      )}
      <button
        className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
        title="Copy link to this doc"
        aria-label="Copy link to this doc"
        onClick={() => {
          void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/wb/${boardId}?doc=${docId}`).catch(() => undefined);
          toast.push({ kind: "success", title: "Link copied" });
        }}
      >
        <Link2 size={17} />
      </button>
      <button className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" onClick={onClose} title="Close" aria-label="Close doc">
        <X size={18} />
      </button>
    </header>
  );
}

// --------------------------------------------------------------- toolbar --
function Toolbar({ editor, uploading, onImages }: { editor: Editor; uploading: number; onImages: (files: File[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  // Re-render on every change of selection / marks.
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    editor.on("transaction", fn);
    return () => {
      editor.off("transaction", fn);
    };
  }, [editor]);
  const [linkOpen, setLinkOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && editor.isFocused) {
        e.preventDefault();
        setLinkOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  const c = () => editor.chain().focus();
  // Menus hand focus back to their trigger on close: run the command after that.
  const act = (close: () => void, fn: () => void) => {
    close();
    requestAnimationFrame(fn);
  };
  const style = editor.isActive("heading", { level: 1 })
    ? "Heading 1"
    : editor.isActive("heading", { level: 2 })
      ? "Heading 2"
      : editor.isActive("heading", { level: 3 })
        ? "Heading 3"
        : "Text";
  const inTable = editor.isActive("table");

  return (
    <div
      className="shrink-0 flex items-center gap-0.5 px-2 sm:px-3 h-11 bg-surface border-b border-border overflow-x-auto [scrollbar-width:none]"
      role="toolbar"
      aria-label="Formatting"
      onMouseDown={(e) => {
        // Keep the editor's selection while clicking buttons.
        if ((e.target as HTMLElement).closest("button")) e.preventDefault();
      }}
    >
      <Menu
        trigger={
          <button className="h-8 shrink-0 inline-flex items-center gap-1 px-2 rounded-md text-sm text-ink hover:bg-inset w-[112px] justify-between" aria-label="Text style">
            {style} <ChevronDown size={14} className="text-subtle" />
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[180px]">
            <MenuItem onClick={() => act(close, () => c().setParagraph().run())}>
              <span className="text-sm">Text</span>
            </MenuItem>
            <MenuItem onClick={() => act(close, () => c().toggleHeading({ level: 1 }).run())}>
              <span className="text-xl font-bold">Heading 1</span>
            </MenuItem>
            <MenuItem onClick={() => act(close, () => c().toggleHeading({ level: 2 }).run())}>
              <span className="text-lg font-bold">Heading 2</span>
            </MenuItem>
            <MenuItem onClick={() => act(close, () => c().toggleHeading({ level: 3 }).run())}>
              <span className="text-base font-semibold">Heading 3</span>
            </MenuItem>
          </div>
        )}
      </Menu>
      <Sep />
      <Btn on={editor.isActive("bold")} onClick={() => c().toggleBold().run()} label="Bold (Ctrl+B)">
        <Bold size={16} />
      </Btn>
      <Btn on={editor.isActive("italic")} onClick={() => c().toggleItalic().run()} label="Italic (Ctrl+I)">
        <Italic size={16} />
      </Btn>
      <Btn on={editor.isActive("underline")} onClick={() => c().toggleUnderline().run()} label="Underline (Ctrl+U)">
        <UnderlineIcon size={16} />
      </Btn>
      <Btn on={editor.isActive("strike")} onClick={() => c().toggleStrike().run()} label="Strikethrough">
        <Strikethrough size={16} />
      </Btn>
      <Btn on={editor.isActive("highlight")} onClick={() => c().toggleHighlight().run()} label="Highlight">
        <Highlighter size={16} />
      </Btn>
      <Btn on={editor.isActive("code")} onClick={() => c().toggleCode().run()} label="Inline code">
        <Code size={16} />
      </Btn>
      <div className="relative shrink-0">
        <Btn on={editor.isActive("link") || linkOpen} onClick={() => setLinkOpen((o) => !o)} label="Link (Ctrl+K)">
          <Link2 size={16} />
        </Btn>
        {linkOpen && <LinkForm editor={editor} onClose={() => setLinkOpen(false)} />}
      </div>
      <Sep />
      <Btn on={editor.isActive("bulletList")} onClick={() => c().toggleBulletList().run()} label="Bulleted list">
        <List size={16} />
      </Btn>
      <Btn on={editor.isActive("orderedList")} onClick={() => c().toggleOrderedList().run()} label="Numbered list">
        <ListOrdered size={16} />
      </Btn>
      <Btn on={editor.isActive("taskList")} onClick={() => c().toggleTaskList().run()} label="Checklist">
        <ListChecks size={16} />
      </Btn>
      <Btn on={editor.isActive("blockquote")} onClick={() => c().toggleBlockquote().run()} label="Quote">
        <Quote size={16} />
      </Btn>
      <Btn on={editor.isActive("codeBlock")} onClick={() => c().toggleCodeBlock().run()} label="Code block">
        <Code2 size={16} />
      </Btn>
      <Btn onClick={() => c().setHorizontalRule().run()} label="Divider">
        <Minus size={16} />
      </Btn>
      <Btn onClick={() => fileRef.current?.click()} label={uploading ? "Uploading image…" : "Image"} disabled={uploading > 0}>
        {uploading ? <Spinner size={14} /> : <ImagePlus size={16} />}
      </Btn>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onImages(files);
        }}
      />
      <Menu
        trigger={
          <button className={cn("h-8 w-8 shrink-0 grid place-items-center rounded-md", inTable ? "bg-accent-soft text-accent" : "text-muted hover:bg-inset hover:text-ink")} aria-label="Table" title="Table">
            <Table2 size={16} />
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[200px]">
            {!inTable ? (
              <MenuItem onClick={() => act(close, () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}>Insert 3 × 3 table</MenuItem>
            ) : (
              <>
                <MenuItem onClick={() => act(close, () => c().addRowAfter().run())}>Add row below</MenuItem>
                <MenuItem onClick={() => act(close, () => c().addColumnAfter().run())}>Add column right</MenuItem>
                <MenuItem onClick={() => act(close, () => c().toggleHeaderRow().run())}>Toggle header row</MenuItem>
                <MenuDivider />
                <MenuItem onClick={() => act(close, () => c().deleteRow().run())}>Delete row</MenuItem>
                <MenuItem onClick={() => act(close, () => c().deleteColumn().run())}>Delete column</MenuItem>
                <MenuItem destructive onClick={() => act(close, () => c().deleteTable().run())}>
                  Delete table
                </MenuItem>
              </>
            )}
          </div>
        )}
      </Menu>
      <Sep />
      <Btn on={editor.isActive({ textAlign: "left" })} onClick={() => c().setTextAlign("left").run()} label="Align left">
        <AlignLeft size={16} />
      </Btn>
      <Btn on={editor.isActive({ textAlign: "center" })} onClick={() => c().setTextAlign("center").run()} label="Align center">
        <AlignCenter size={16} />
      </Btn>
      <Btn on={editor.isActive({ textAlign: "right" })} onClick={() => c().setTextAlign("right").run()} label="Align right">
        <AlignRight size={16} />
      </Btn>
      <Sep />
      <Btn onClick={() => c().undo().run()} label="Undo (Ctrl+Z)" disabled={!editor.can().undo()}>
        <Undo2 size={16} />
      </Btn>
      <Btn onClick={() => c().redo().run()} label="Redo (Ctrl+Shift+Z)" disabled={!editor.can().redo()}>
        <Redo2 size={16} />
      </Btn>
    </div>
  );
}

/** People picker for @mentions, under the caret. */
function MentionPicker({ menu }: { menu: MentionMenu }) {
  const r = menu.rect!;
  const below = r.bottom + 260 < window.innerHeight;
  return (
    <div
      role="listbox"
      aria-label="Mention someone"
      className="fixed z-[60] w-64 max-w-[calc(100vw-16px)] p-1 bg-surface border border-border rounded-lg shadow-raise animate-menu-in"
      style={{ left: Math.max(8, Math.min(r.left, window.innerWidth - 264)), ...(below ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {menu.items.length === 0 ? (
        <div className="px-3 py-2 text-sm text-subtle">No one matches.</div>
      ) : (
        menu.items.map((p, i) => (
          <button
            key={p.id}
            role="option"
            aria-selected={i === menu.index}
            onClick={() => menu.pick(p)}
            className={cn("w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left", i === menu.index ? "bg-accent-soft" : "hover:bg-inset")}
          >
            <Avatar name={p.display_name} src={p.avatar_url} size={24} />
            <span className="min-w-0">
              <span className="block text-sm text-ink truncate">{p.display_name}</span>
              <span className="block text-xs text-subtle truncate">@{p.username}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function Sep() {
  return <span className="h-5 w-px bg-line mx-1 shrink-0" />;
}

function Btn({ on, onClick, label, disabled, children }: { on?: boolean; onClick: () => void; label: string; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={cn(
        "h-8 w-8 shrink-0 grid place-items-center rounded-md transition-colors disabled:opacity-35",
        on ? "bg-accent-soft text-accent" : "text-muted hover:bg-inset hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function LinkForm({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState(() => (editor.getAttributes("link").href as string | undefined) ?? "");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [onClose]);
  const apply = () => {
    const u = url.trim();
    if (!u) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else {
      const href = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
      // Only web and mail links.
      if (!/^(https?:|mailto:)/i.test(href)) return;
      if (editor.state.selection.empty && !editor.isActive("link")) editor.chain().focus().insertContent({ type: "text", text: u, marks: [{ type: "link", attrs: { href } }] }).run();
      else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onClose();
  };
  return (
    <div ref={ref} role="menu" className="fixed sm:absolute z-50 left-2 right-2 sm:left-0 sm:right-auto top-[7.5rem] sm:top-full sm:mt-1 sm:w-80 p-2 bg-surface border border-border rounded-lg shadow-raise animate-menu-in">
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Paste a link"
          aria-label="Link address"
          className="min-w-0 flex-1 h-9 px-2 rounded-md border border-border bg-surface text-lg sm:text-sm text-ink outline-none focus:border-accent"
        />
        <button type="submit" className="h-9 px-3 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover">
          {url.trim() ? "Save" : "Remove"}
        </button>
      </form>
    </div>
  );
}
