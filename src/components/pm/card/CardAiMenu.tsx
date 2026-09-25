import { useEffect, useRef, useState } from "react";
import { AlignLeft, CheckSquare, FileText, MessageSquare, Paperclip, RotateCcw, X } from "lucide-react";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { AiButton, AiNote, AiThinking } from "@/components/ui/Ai";
import { Markdown } from "@/components/pm/Markdown";
import { useToast } from "@/components/ui/Toast";
import { useDraft } from "@/lib/drafts";
import { ai, prepareFiles, type AiAssistResult } from "@/lib/ai";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// "AI" on a card: tell it what to do ("write a status comment", "turn the
// description into a checklist"...), optionally with files. It prepares a
// comment, a description and/or a checklist; each is applied only when the
// user clicks it. Descriptions land as a draft that still needs Save.
// -----------------------------------------------------------------------------

interface Props {
  cardId: string;
  canEdit: boolean;
  canChecklist: boolean;
  canComment: boolean;
  onUseDescription: (markdown: string) => void;
  onChecklistAdded: () => void;
  onPostComment: (markdown: string) => Promise<void>;
}

const SUGGESTIONS = [
  "Write a short status update comment",
  "Summarize this card as a comment",
  "Turn the description into a checklist",
  "Rewrite the description to be clearer",
  "Draft a reply to the latest comment",
];

export function CardAiMenu(props: Props) {
  return (
    <Menu trigger={<AiButton>AI</AiButton>}>
      {(close) => <Panel {...props} close={close} />}
    </Menu>
  );
}

function Panel({
  cardId,
  canEdit,
  canChecklist,
  canComment,
  onUseDescription,
  onChecklistAdded,
  onPostComment,
  close,
}: Props & { close: () => void }) {
  const toast = useToast();
  const ask = useDraft(`ai-ask:${cardId}`);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<AiAssistResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function send(text = ask.value) {
    if (!text.trim()) return setErr("Tell the AI what to do.");
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setErr(null);
    setBusy(true);
    try {
      const prepared = await prepareFiles(files);
      const r = await ai.assist(cardId, text, prepared, ctl.signal);
      setRes(r);
      ask.discard();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-[min(440px,calc(100vw-2rem))] px-3 py-3 space-y-3">
      {busy ? (
        <AiThinking
          onCancel={() => {
            abort.current?.abort();
            setBusy(false);
          }}
        />
      ) : res ? (
        <Result
          res={res}
          cardId={cardId}
          canEdit={canEdit}
          canChecklist={canChecklist}
          canComment={canComment}
          onBack={() => setRes(null)}
          onUseDescription={(md) => {
            onUseDescription(md);
            close();
          }}
          onChecklistAdded={onChecklistAdded}
          onPostComment={async (md) => {
            try {
              await onPostComment(md);
              toast.push({ kind: "success", title: "Comment posted" });
              return true;
            } catch (e) {
              toast.push({ kind: "error", title: "Couldn't post", description: (e as Error).message });
              return false;
            }
          }}
        />
      ) : (
        <>
          <Textarea
            autoFocus
            rows={3}
            value={ask.value}
            onChange={(e) => ask.set(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Tell AI what to do with this card..."
          />
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                className="rounded-full border border-line bg-inset px-2.5 py-0.5 text-xs text-muted hover:text-ink hover:border-rule"
              >
                {s}
              </button>
            ))}
          </div>

          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}:${f.size}`} className="flex items-center gap-2 rounded-md border border-line bg-inset px-2 py-1 text-xs">
                  <FileText size={13} className="text-muted shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-ink">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                    className="grid place-items-center h-5 w-5 rounded-md text-muted hover:bg-border/70 hover:text-ink"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {err && <p className="text-sm text-danger">{err}</p>}

          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" iconLeft={<Paperclip size={14} />} onClick={() => fileInput.current?.click()}>
              Add files
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const list = e.target.files;
                if (list?.length) setFiles((cur) => [...cur, ...Array.from(list)]);
                e.target.value = "";
              }}
            />
            <span className="flex-1" />
            <AiButton onClick={() => void send()}>Ask AI</AiButton>
          </div>
          <AiNote>The AI prepares changes. Nothing is posted or saved until you apply it.</AiNote>
        </>
      )}
    </div>
  );
}

function Result({
  res,
  cardId,
  canEdit,
  canChecklist,
  canComment,
  onBack,
  onUseDescription,
  onChecklistAdded,
  onPostComment,
}: {
  res: AiAssistResult;
  cardId: string;
  canEdit: boolean;
  canChecklist: boolean;
  canComment: boolean;
  onBack: () => void;
  onUseDescription: (md: string) => void;
  onChecklistAdded: () => void;
  onPostComment: (md: string) => Promise<boolean>;
}) {
  const [comment, setComment] = useState(res.comment ?? "");
  const [posted, setPosted] = useState(false);
  const [posting, setPosting] = useState(false);
  const nothing = !res.comment && !res.description && !res.checklist;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm text-ink">{res.reply || (nothing ? "Nothing to change." : "Here's what I prepared.")}</p>
        <Button size="sm" variant="ghost" iconLeft={<RotateCcw size={14} />} onClick={onBack}>
          New request
        </Button>
      </div>

      {res.comment && canComment && (
        <Block icon={<MessageSquare size={13} />} title="Comment">
          <Textarea rows={5} value={comment} onChange={(e) => setComment(e.target.value)} disabled={posted} />
          <Button
            size="sm"
            variant="primary"
            loading={posting}
            disabled={posted || !comment.trim()}
            onClick={async () => {
              setPosting(true);
              if (await onPostComment(comment.trim())) setPosted(true);
              setPosting(false);
            }}
          >
            {posted ? "Posted" : "Post comment"}
          </Button>
        </Block>
      )}

      {res.description && canEdit && (
        <Block icon={<AlignLeft size={13} />} title="Description">
          <div className="max-h-[30vh] overflow-y-auto rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink">
            <Markdown text={res.description} />
          </div>
          <Button size="sm" variant="primary" onClick={() => onUseDescription(res.description!)}>
            Use as description
          </Button>
          <p className="text-[11px] text-subtle">Opens as a draft. Press Save to keep it.</p>
        </Block>
      )}

      {res.checklist && canChecklist && (
        <ChecklistBlock cardId={cardId} name={res.checklist.name} initial={res.checklist.items} onAdded={onChecklistAdded} />
      )}
    </div>
  );
}

function ChecklistBlock({
  cardId,
  name: initialName,
  initial,
  onAdded,
}: {
  cardId: string;
  name: string;
  initial: string[];
  onAdded: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [items, setItems] = useState(initial.map((text) => ({ text, on: true })));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const chosen = items.filter((i) => i.on && i.text.trim());

  async function add() {
    setBusy(true);
    try {
      const base = Date.now();
      const { data: cl, error } = await supabase
        .from("checklist")
        .insert({ card_id: cardId, name: name.trim() || "Checklist", position: `p${base}` })
        .select("id")
        .single();
      if (error) throw error;
      const { error: e2 } = await supabase.from("checklist_item").insert(
        chosen.map((i, n) => ({
          checklist_id: (cl as { id: string }).id,
          text: i.text.trim(),
          position: `p${base}${String(n).padStart(3, "0")}`,
        })),
      );
      if (e2) throw e2;
      setDone(true);
      toast.push({ kind: "success", title: `Checklist added (${chosen.length} items)` });
      onAdded();
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't add checklist", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block icon={<CheckSquare size={13} />} title="Checklist">
      <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Checklist name" disabled={done} />
      <ul className="max-h-[30vh] overflow-y-auto space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="accent-accent w-4 h-4 mt-2 shrink-0"
              checked={it.on}
              disabled={done}
              onChange={() => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
              aria-label="Include step"
            />
            <input
              value={it.text}
              disabled={done}
              onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              className={cn(
                "flex-1 min-w-0 rounded-md bg-transparent px-2 py-1 text-sm text-ink hover:bg-inset focus:bg-inset outline-none",
                !it.on && "line-through text-subtle",
              )}
            />
          </li>
        ))}
      </ul>
      <Button size="sm" variant="primary" loading={busy} disabled={done || !chosen.length} onClick={add}>
        {done ? "Added" : `Add checklist (${chosen.length})`}
      </Button>
    </Block>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}
