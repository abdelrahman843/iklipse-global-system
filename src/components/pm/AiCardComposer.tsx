import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, RotateCcw, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { AiButton, AiNote, AiThinking } from "@/components/ui/Ai";
import { Markdown } from "@/components/pm/Markdown";
import { readableText } from "@/components/pm/ColorPicker";
import { useToast } from "@/components/ui/Toast";
import { useDraft } from "@/lib/drafts";
import { ai, prepareFiles, type AiCardDraft } from "@/lib/ai";
import { createCard, toggleCardLabel, updateCard } from "@/lib/pm/boardApi";
import { uploadCardAttachment, formatSize } from "@/lib/pm/attachmentsApi";
import { supabase } from "@/lib/supabase";
import type { Label as LabelT } from "@/lib/database.types";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// "Add card with AI", Trello capture style: drop in a brief, data and files,
// the AI proposes one structured card (title, description, dates, checklist,
// labels), you review and edit it, then it's created with the files attached.
// -----------------------------------------------------------------------------

interface Props {
  boardId: string;
  listId: string;
  listTitle: string;
  /** Position of the last card in the list (new card goes after it). */
  afterPos: string | null;
  labels: LabelT[];
  initialBrief?: string;
  onClose: () => void;
  onCreated: (cardId: string) => void;
}

type Step = "input" | "thinking" | "review";

export function AiCardComposer({ boardId, listId, listTitle, afterPos, labels, initialBrief, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  // The brief is a draft like every other composer: closing keeps it.
  const brief = useDraft(`ai-card:${listId}`);
  const [files, setFiles] = useState<File[]>([]);
  const [step, setStep] = useState<Step>("input");
  const [err, setErr] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [draft, setDraft] = useState<AiCardDraft | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [items, setItems] = useState<{ text: string; on: boolean }[]>([]);
  const [attach, setAttach] = useState(true);
  const [preview, setPreview] = useState(true);
  const [creating, setCreating] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (initialBrief?.trim() && !brief.value.trim()) brief.set(initialBrief);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => `${f.name}:${f.size}`));
      return [...cur, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  async function generate() {
    if (!brief.value.trim() && !files.length) return setErr("Add a brief or some files first.");
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setErr(null);
    setStep("thinking");
    try {
      const prepared = await prepareFiles(files);
      setSkipped(prepared.skipped);
      const d = await ai.card(boardId, listId, brief.value, prepared, ctl.signal);
      const byName = new Map(labels.filter((l) => l.name.trim()).map((l) => [l.name.trim().toLowerCase(), l.id]));
      setDraft(d);
      setLabelIds(d.labels.map((n) => byName.get(n.toLowerCase())).filter((x): x is string => !!x));
      setItems((d.checklist?.items ?? []).map((text) => ({ text, on: true })));
      setStep("review");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr((e as Error).message);
      setStep("input");
    }
  }

  async function create() {
    if (!draft || !draft.title.trim()) return setErr("The card needs a title.");
    setCreating(true);
    setErr(null);
    const problems: string[] = [];
    try {
      const card = await createCard(boardId, listId, draft.title.trim(), afterPos);
      const at5pm = (d: string) => new Date(`${d}T17:00:00`).toISOString();
      await updateCard(card.id, {
        description: draft.description,
        due_date: draft.due_date ? at5pm(draft.due_date) : null,
        start_date: draft.start_date,
      });

      const chosen = items.filter((i) => i.on && i.text.trim());
      if (chosen.length) {
        try {
          const base = Date.now();
          const { data: cl, error } = await supabase
            .from("checklist")
            .insert({ card_id: card.id, name: draft.checklist?.name || "Checklist", position: `p${base}` })
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
        } catch {
          problems.push("checklist");
        }
      }

      for (const id of labelIds) {
        try {
          await toggleCardLabel(card.id, id, true);
        } catch {
          problems.push("a label");
        }
      }

      if (attach) {
        for (const f of files) {
          try {
            await uploadCardAttachment(card.id, f);
          } catch {
            problems.push(f.name);
          }
        }
      }

      brief.discard();
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      toast.push(
        problems.length
          ? { kind: "info", title: "Card created", description: `Couldn't add: ${problems.join(", ")}` }
          : { kind: "success", title: "Card created with AI" },
      );
      onCreated(card.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const update = (patch: Partial<AiCardDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <Modal
      open
      onClose={onClose}
      size={step === "review" ? "xl" : "lg"}
      title={
        <span className="inline-flex items-center gap-2">
          Add card with AI <span className="text-sm font-normal text-muted">in {listTitle}</span>
        </span>
      }
      footer={
        step === "review" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("input")} disabled={creating}>
              Back
            </Button>
            <Button variant="secondary" iconLeft={<RotateCcw size={14} />} onClick={generate} disabled={creating}>
              Regenerate
            </Button>
            <Button variant="primary" loading={creating} onClick={create}>
              Create card
            </Button>
          </>
        ) : step === "input" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <AiButton size="md" onClick={generate}>
              Generate card
            </AiButton>
          </>
        ) : null
      }
    >
      {step === "thinking" && (
        <AiThinking
          label={files.length ? `Reading ${files.length} file${files.length > 1 ? "s" : ""} and building the card...` : "Building the card..."}
          onCancel={() => {
            abort.current?.abort();
            setStep("input");
          }}
        />
      )}

      {step === "input" && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="ai-brief">Brief, notes or data</Label>
            <Textarea
              id="ai-brief"
              autoFocus
              rows={8}
              value={brief.value}
              onChange={(e) => brief.set(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
              }}
              placeholder="Paste the client brief, an email, meeting notes, numbers... and tell the AI anything specific, e.g. 'due next Thursday, split the work into steps'."
            />
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInput.current?.click()}
            className={cn(
              "rounded-lg border-2 border-dashed px-4 py-5 text-center cursor-pointer",
              dragOver ? "border-accent bg-accent-soft" : "border-border hover:border-rule hover:bg-inset",
            )}
          >
            <Upload size={18} className="mx-auto text-muted" />
            <div className="mt-1.5 text-sm text-ink font-medium">Drop files here or click to upload</div>
            <div className="text-xs text-muted mt-0.5">
              The AI reads PDFs, images, Word (.docx), text and CSV. Every file is attached to the card.
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}:${f.size}`} className="flex items-center gap-2 rounded-md border border-line bg-inset px-2.5 py-1.5 text-sm">
                  <FileText size={14} className="text-muted shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-ink">{f.name}</span>
                  <span className="text-xs text-subtle shrink-0">{formatSize(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                    className="grid place-items-center h-6 w-6 rounded-md text-muted hover:bg-border/70 hover:text-ink"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {err && <p className="text-sm text-danger">{err}</p>}
          <AiNote>The AI only proposes the card. You review everything before it's created.</AiNote>
        </div>
      )}

      {step === "review" && draft && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="ai-title">Title</Label>
            <Input id="ai-title" value={draft.title} onChange={(e) => update({ title: e.target.value })} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label>Description</Label>
              <button type="button" onClick={() => setPreview((v) => !v)} className="text-xs text-muted hover:text-ink">
                {preview ? "Edit" : "Preview"}
              </button>
            </div>
            {preview ? (
              <div
                className="max-h-[38vh] overflow-y-auto rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink cursor-text"
                onClick={() => setPreview(false)}
              >
                <Markdown text={draft.description || "_No description_"} />
              </div>
            ) : (
              <Textarea rows={12} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ai-start">Start date</Label>
              <Input id="ai-start" type="date" value={draft.start_date ?? ""} onChange={(e) => update({ start_date: e.target.value || null })} />
            </div>
            <div>
              <Label htmlFor="ai-due">Due date</Label>
              <Input id="ai-due" type="date" value={draft.due_date ?? ""} onChange={(e) => update({ due_date: e.target.value || null })} />
            </div>
          </div>

          {labels.some((l) => l.name.trim()) && (
            <div>
              <Label>Labels</Label>
              <div className="flex flex-wrap gap-1.5">
                {labels
                  .filter((l) => l.name.trim())
                  .map((l) => {
                    const on = labelIds.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => setLabelIds((xs) => (on ? xs.filter((x) => x !== l.id) : [...xs, l.id]))}
                        className={cn("h-7 px-2.5 rounded-md text-xs font-medium", on ? "ring-2 ring-accent-ring ring-offset-1 ring-offset-surface" : "opacity-45 hover:opacity-80")}
                        style={{ background: l.color, color: readableText(l.color) }}
                      >
                        {l.name}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div>
              <Label>Checklist: {draft.checklist?.name}</Label>
              <ul className="space-y-1">
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
            </div>
          )}

          {files.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input type="checkbox" className="accent-accent w-4 h-4" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
              <Paperclip size={14} className="text-muted" />
              Attach {files.length} file{files.length > 1 ? "s" : ""} to the card
            </label>
          )}
          {skipped.length > 0 && (
            <p className="text-xs text-muted">
              The AI couldn't read: {skipped.join(", ")}. {attach ? "They're still attached." : ""}
            </p>
          )}
          {err && <p className="text-sm text-danger">{err}</p>}
          <AiNote />
        </div>
      )}
    </Modal>
  );
}
