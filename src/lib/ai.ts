import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AiModel } from "@/lib/database.types";

// -----------------------------------------------------------------------------
// AI assistant client, Trello "capture" style. The browser never sees the
// OpenAI key: ai_start() checks permissions and queues the request inside the
// database (pg_net), then we poll ai_poll() until the answer lands.
// See migrations 0014 and 0017.
// -----------------------------------------------------------------------------

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  /** enabled && configured. Show AI entry points only when true. */
  available: boolean;
  model: AiModel;
  // Admin only:
  key_hint?: string | null;
  requests_30d?: number;
  tokens_30d?: number;
}

export interface AiChecklist {
  name: string;
  items: string[];
}

/** A card proposed from a brief + files. Nothing exists until the user creates it. */
export interface AiCardDraft {
  title: string;
  description: string;
  due_date: string | null;
  start_date: string | null;
  checklist: AiChecklist | null;
  labels: string[];
}

/** What the in-card assistant prepared. Each part is applied separately. */
export interface AiAssistResult {
  reply: string;
  comment: string | null;
  description: string | null;
  checklist: AiChecklist | null;
}

export const AI_MODELS: { value: AiModel; label: string; hint: string }[] = [
  { value: "gpt-4o-mini", label: "GPT-4o mini", hint: "Fast and cheapest. Reads images and PDFs." },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini", hint: "Fast, better writing. Reads images and PDFs." },
  { value: "gpt-4o", label: "GPT-4o", hint: "Stronger, costs more." },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "Stronger, costs more." },
  { value: "gpt-5-mini", label: "GPT-5 mini", hint: "Smart, slower." },
  { value: "gpt-5", label: "GPT-5", hint: "Smartest, slowest." },
];

export async function fetchAiStatus(): Promise<AiStatus> {
  const { data, error } = await supabase.rpc("ai_status");
  if (error) throw error;
  return data as AiStatus;
}

export function useAiStatus() {
  return useQuery({ queryKey: ["ai-status"], queryFn: fetchAiStatus, staleTime: 60_000 });
}

export async function setAiKey(key: string | null) {
  const { error } = await supabase.rpc("ai_set_key", { p_key: key });
  if (error) throw error;
}

// ------------------------------------------------------------------ files --

/** OpenAI content part: an image or a PDF, inlined as a data URL. */
type Part =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface PreparedFiles {
  /** Text pulled out of text-like files, appended to the brief. */
  text: string;
  parts: Part[];
  /** Files the AI can't read (still attached to the card). */
  skipped: string[];
}

const MAX_TEXT_PER_FILE = 40_000;
const MAX_INLINE_BYTES = 12 * 1024 * 1024; // images + PDFs sent to OpenAI, in total
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log|rtf)$/i;

const dataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** Turn uploads into something the model can read: text is extracted in the
 *  browser, images and PDFs are sent as content parts. */
export async function prepareFiles(files: File[]): Promise<PreparedFiles> {
  const out: PreparedFiles = { text: "", parts: [], skipped: [] };
  let inline = 0;
  for (const f of files) {
    const isImage = /^image\/(png|jpe?g|webp|gif)$/i.test(f.type);
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    const isDocx = /\.docx$/i.test(f.name);
    const isText = f.type.startsWith("text/") || f.type === "application/json" || TEXT_EXT.test(f.name);
    try {
      if (isText || isDocx) {
        let body: string;
        if (isDocx) {
          const mammoth = await import("mammoth");
          body = (await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })).value;
        } else {
          body = await f.text();
        }
        const cut = body.length > MAX_TEXT_PER_FILE ? `${body.slice(0, MAX_TEXT_PER_FILE)}\n[... truncated]` : body;
        out.text += `\n\n--- File: ${f.name} ---\n${cut.trim()}`;
      } else if ((isImage || isPdf) && inline + f.size <= MAX_INLINE_BYTES) {
        inline += f.size;
        const url = await dataUrl(f);
        out.parts.push(
          isImage
            ? { type: "image_url", image_url: { url } }
            : { type: "file", file: { filename: f.name, file_data: url } },
        );
        out.text += `\n\n--- File: ${f.name} (attached${isImage ? " image" : " PDF"}) ---`;
      } else {
        out.skipped.push(f.name);
      }
    } catch {
      out.skipped.push(f.name);
    }
  }
  if (out.parts.length > 10) {
    out.skipped.push(...out.parts.slice(10).map(() => "extra file"));
    out.parts = out.parts.slice(0, 10);
  }
  return out;
}

// -------------------------------------------------------------------- run --

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run<T>(
  action: "card" | "assist" | "ping",
  args: { board?: string; card?: string; list?: string; text?: string; parts?: Part[] },
  signal?: AbortSignal,
): Promise<T> {
  const { data: id, error } = await supabase.rpc("ai_start", {
    p_action: action,
    p_board: args.board ?? null,
    p_card: args.card ?? null,
    p_text: args.text ?? null,
    p_parts: args.parts?.length ? args.parts : null,
    p_list: args.list ?? null,
  });
  if (error) throw new Error(error.message);

  const started = Date.now();
  let wait = 800;
  while (Date.now() - started < 200_000) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    await sleep(wait);
    wait = Math.min(wait + 300, 2000);
    const { data, error: pollErr } = await supabase.rpc("ai_poll", { p_id: id as string });
    if (pollErr) throw new Error(pollErr.message);
    const r = data as { status: "pending" | "done" | "error"; result: unknown; error: string | null };
    if (r.status === "done") return r.result as T;
    if (r.status === "error") throw new Error(r.error ?? "AI request failed");
  }
  throw new Error("The AI took too long to answer. Try again.");
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
function checklistOf(v: unknown): AiChecklist | null {
  const c = v as { name?: unknown; items?: unknown } | null;
  const items = Array.isArray(c?.items) ? c!.items.map(str).filter(Boolean) : [];
  return items.length ? { name: str(c?.name) || "Checklist", items } : null;
}

export const ai = {
  /** Brief + files → a proposed card for this list. */
  async card(boardId: string, listId: string, brief: string, files: PreparedFiles, signal?: AbortSignal) {
    const r = await run<Record<string, unknown>>(
      "card",
      { board: boardId, list: listId, text: `${brief.trim()}${files.text}`.trim(), parts: files.parts },
      signal,
    );
    return {
      title: str(r.title).slice(0, 200) || "Untitled card",
      description: str(r.description),
      due_date: isoDate(r.due_date),
      start_date: isoDate(r.start_date),
      checklist: checklistOf(r.checklist),
      labels: Array.isArray(r.labels) ? r.labels.map(str).filter(Boolean) : [],
    } satisfies AiCardDraft;
  },
  /** Instruction inside a card → comment / description / checklist proposals. */
  async assist(cardId: string, instruction: string, files: PreparedFiles, signal?: AbortSignal) {
    const r = await run<Record<string, unknown>>(
      "assist",
      { card: cardId, text: `${instruction.trim()}${files.text}`, parts: files.parts },
      signal,
    );
    return {
      reply: str(r.reply),
      comment: str(r.comment) || null,
      description: str(r.description) || null,
      checklist: checklistOf(r.checklist),
    } satisfies AiAssistResult;
  },
  ping: () => run<string>("ping", {}),
};
