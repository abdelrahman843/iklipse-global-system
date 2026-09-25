import { useEffect, useRef, useState } from "react";
import { AlignLeft, ArrowLeft, CheckSquare, Copy, FileText, MessageSquare, RotateCcw, Wand2 } from "lucide-react";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AiButton, AiNote, AiThinking } from "@/components/ui/Ai";
import { Markdown } from "@/components/pm/Markdown";
import { useToast } from "@/components/ui/Toast";
import { ai, AI_WRITE_MODES, type AiChecklist, type AiWriteMode } from "@/lib/ai";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// "AI" chip on the card (Atlassian Intelligence style). Every result is a
// suggestion: description rewrites land as a *draft* the user still has to
// Save, checklists are previewed and trimmed before they're added, summaries
// are only posted as a comment on request.
// -----------------------------------------------------------------------------

interface Props {
  cardId: string;
  cardTitle: string;
  /** Current description (the draft if there is one). */
  description: string;
  canEdit: boolean;
  canChecklist: boolean;
  canComment: boolean;
  onUseDescription: (markdown: string) => void;
  onChecklistAdded: () => void;
  onPostComment: (markdown: string) => Promise<void>;
}

type Job =
  | { kind: "write"; mode: AiWriteMode }
  | { kind: "checklist" }
  | { kind: "summary" };

type View =
  | { step: "menu" }
  | { step: "loading"; job: Job }
  | { step: "text"; job: Job; text: string }
  | { step: "checklist"; data: AiChecklist }
  | { step: "error"; job: Job; message: string };

export function CardAiMenu(props: Props) {
  return (
    <Menu trigger={<AiButton>AI</AiButton>}>
      {(close) => <Panel {...props} close={close} />}
    </Menu>
  );
}

function Panel({
  cardId,
  cardTitle,
  description,
  canEdit,
  canChecklist,
  canComment,
  onUseDescription,
  onChecklistAdded,
  onPostComment,
  close,
}: Props & { close: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<View>({ step: "menu" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const hasText = description.trim().length > 0;

  async function start(job: Job) {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setView({ step: "loading", job });
    try {
      if (job.kind === "write") {
        // Empty description: "Make longer" drafts one from the title.
        const src = hasText ? description : `Card title: ${cardTitle}`;
        const text = await ai.write(cardId, src, job.mode, ctl.signal);
        setView({ step: "text", job, text });
      } else if (job.kind === "summary") {
        const text = await ai.summary(cardId, ctl.signal);
        setView({ step: "text", job, text });
      } else {
        const data = await ai.checklist(cardId, ctl.signal);
        const items = (Array.isArray(data?.items) ? data.items : []).map(String).filter((s) => s.trim());
        if (!items.length) throw new Error("The AI didn't suggest any steps. Try again.");
        setView({ step: "checklist", data: { name: String(data.name || "Checklist"), items } });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setView({ step: "error", job, message: (e as Error).message });
    }
  }

  const cancel = () => {
    abort.current?.abort();
    setView({ step: "menu" });
  };

  return (
    <div className="w-[min(380px,calc(100vw-2rem))] px-3 py-2.5">
      {view.step !== "menu" && view.step !== "loading" && (
        <button
          type="button"
          onClick={() => setView({ step: "menu" })}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
        >
          <ArrowLeft size={13} /> Back
        </button>
      )}

      {view.step === "menu" && (
        <div className="space-y-3">
          {canEdit && (
            <Group icon={<AlignLeft size={13} />} title="Description">
              {hasText ? (
                AI_WRITE_MODES.map((m) => (
                  <Item key={m.value} onClick={() => start({ kind: "write", mode: m.value })}>
                    {m.label}
                  </Item>
                ))
              ) : (
                <Item onClick={() => start({ kind: "write", mode: "expand" })}>Draft a description from the title</Item>
              )}
            </Group>
          )}
          {canChecklist && (
            <Group icon={<CheckSquare size={13} />} title="Checklist">
              <Item onClick={() => start({ kind: "checklist" })}>Suggest checklist steps</Item>
            </Group>
          )}
          <Group icon={<FileText size={13} />} title="Card">
            <Item onClick={() => start({ kind: "summary" })}>Summarize this card</Item>
          </Group>
          <AiNote />
        </div>
      )}

      {view.step === "loading" && <AiThinking onCancel={cancel} />}

      {view.step === "error" && (
        <div className="space-y-3">
          <p className="text-sm text-danger">{view.message}</p>
          <Button size="sm" variant="secondary" iconLeft={<RotateCcw size={14} />} onClick={() => start(view.job)}>
            Try again
          </Button>
        </div>
      )}

      {view.step === "text" && (
        <div className="space-y-3">
          <div className="max-h-[45vh] overflow-y-auto rounded-md border border-line bg-inset px-3 py-2 text-sm">
            <Markdown text={view.text} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {view.job.kind === "write" ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    onUseDescription(view.text);
                    close();
                  }}
                >
                  Replace description
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onUseDescription(hasText ? `${description.trimEnd()}\n\n${view.text}` : view.text);
                    close();
                  }}
                >
                  Insert below
                </Button>
              </>
            ) : (
              canComment && (
                <Button
                  size="sm"
                  variant="primary"
                  iconLeft={<MessageSquare size={14} />}
                  onClick={async () => {
                    try {
                      await onPostComment(view.text);
                      toast.push({ kind: "success", title: "Summary posted as a comment" });
                      close();
                    } catch (e) {
                      toast.push({ kind: "error", title: "Couldn't post", description: (e as Error).message });
                    }
                  }}
                >
                  Post as comment
                </Button>
              )
            )}
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<Copy size={14} />}
              onClick={() => {
                void navigator.clipboard?.writeText(view.text);
                toast.push({ kind: "info", title: "Copied" });
              }}
            >
              Copy
            </Button>
            <Button size="sm" variant="ghost" iconLeft={<RotateCcw size={14} />} onClick={() => start(view.job)}>
              Retry
            </Button>
          </div>
          {view.job.kind === "write" && <AiNote>Goes into the description as a draft — you still press Save.</AiNote>}
        </div>
      )}

      {view.step === "checklist" && (
        <ChecklistPreview
          cardId={cardId}
          initial={view.data}
          onRetry={() => start({ kind: "checklist" })}
          onAdded={() => {
            onChecklistAdded();
            close();
          }}
        />
      )}
    </div>
  );
}

function ChecklistPreview({
  cardId,
  initial,
  onRetry,
  onAdded,
}: {
  cardId: string;
  initial: AiChecklist;
  onRetry: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial.name);
  const [items, setItems] = useState(initial.items.map((text) => ({ text, on: true })));
  const [busy, setBusy] = useState(false);
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
      const { error: itemsErr } = await supabase.from("checklist_item").insert(
        chosen.map((i, n) => ({
          checklist_id: (cl as { id: string }).id,
          text: i.text.trim(),
          position: `p${base}${String(n).padStart(3, "0")}`,
        })),
      );
      if (itemsErr) throw itemsErr;
      toast.push({ kind: "success", title: `Checklist added (${chosen.length} items)` });
      onAdded();
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't add checklist", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Checklist name" />
      <ul className="max-h-[40vh] overflow-y-auto space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="accent-accent w-4 h-4 mt-2 shrink-0"
              checked={it.on}
              onChange={() => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
              aria-label="Include step"
            />
            <input
              value={it.text}
              onChange={(e) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              className={cn(
                "flex-1 min-w-0 rounded-md bg-transparent px-2 py-1 text-sm text-ink hover:bg-inset focus:bg-inset outline-none",
                !it.on && "line-through text-subtle",
              )}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!chosen.length} onClick={add}>
          Add checklist ({chosen.length})
        </Button>
        <Button size="sm" variant="ghost" iconLeft={<RotateCcw size={14} />} onClick={onRetry} disabled={busy}>
          Retry
        </Button>
      </div>
      <AiNote>Untick or edit steps before adding.</AiNote>
    </div>
  );
}

function Group({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-1 mb-1 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">
        {icon}
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function Item({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left rounded-md px-2 py-1.5 text-sm text-ink hover:bg-inset transition-colors"
    >
      <Wand2 size={14} className="text-[#7c3aed] shrink-0" />
      {children}
    </button>
  );
}
