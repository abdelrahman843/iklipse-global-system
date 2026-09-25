import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { Textarea, Label, FieldError } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { AiButton, AiNote, AiThinking } from "@/components/ui/Ai";
import { ai, type AiBoardPlan } from "@/lib/ai";

const EXAMPLES = [
  "Launch our new website in 6 weeks",
  "Hire a senior designer",
  "Plan the company offsite in Dahab",
  "Social media content calendar for March",
];

/**
 * Describe a goal → preview the board the AI proposes → trim it → create.
 * The plan is only a suggestion until the caller creates it.
 */
export function AiBoardGenerator({
  plan,
  onPlan,
}: {
  plan: AiBoardPlan | null;
  onPlan: (p: AiBoardPlan | null) => void;
}) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function generate() {
    if (!goal.trim()) return setErr("Describe what the board is for.");
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setErr(null);
    setBusy(true);
    try {
      const p = await ai.board(goal.trim(), ctl.signal);
      const lists = (Array.isArray(p?.lists) ? p.lists : [])
        .map((l) => ({
          title: String(l?.title ?? "").trim(),
          cards: (Array.isArray(l?.cards) ? l.cards : [])
            .map((c) => ({ title: String(c?.title ?? "").trim(), description: c?.description ? String(c.description) : undefined }))
            .filter((c) => c.title),
        }))
        .filter((l) => l.title);
      if (!lists.length) throw new Error("The AI didn't return any lists. Try rephrasing.");
      onPlan({ title: String(p.title || goal).slice(0, 120), description: p.description ? String(p.description) : undefined, lists });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (busy) {
    return (
      <AiThinking
        label="Designing your board…"
        onCancel={() => {
          abort.current?.abort();
          setBusy(false);
        }}
      />
    );
  }

  if (plan) {
    const removeList = (i: number) => onPlan({ ...plan, lists: plan.lists.filter((_, j) => j !== i) });
    const removeCard = (i: number, k: number) =>
      onPlan({
        ...plan,
        lists: plan.lists.map((l, j) => (j === i ? { ...l, cards: l.cards.filter((_, n) => n !== k) } : l)),
      });
    return (
      <div className="space-y-3">
        <div>
          <Label>Board title</Label>
          <input
            value={plan.title}
            onChange={(e) => onPlan({ ...plan, title: e.target.value })}
            className="w-full h-9 rounded-md border border-border bg-surface px-3 text-sm text-ink outline-none focus:border-ink"
          />
          {plan.description && <p className="text-xs text-muted mt-1">{plan.description}</p>}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
          {plan.lists.map((l, i) => (
            <div key={i} className="w-48 shrink-0 rounded-lg bg-inset border border-line p-2">
              <div className="flex items-start gap-1 mb-1.5">
                <span className="flex-1 min-w-0 text-sm font-semibold text-ink break-words">{l.title}</span>
                <button type="button" onClick={() => removeList(i)} className="text-subtle hover:text-danger" aria-label="Remove list">
                  <X size={14} />
                </button>
              </div>
              <ul className="space-y-1">
                {l.cards.map((c, k) => (
                  <li
                    key={k}
                    className="group flex items-start gap-1 rounded-md bg-surface shadow-card px-2 py-1.5 text-xs text-ink"
                    title={c.description}
                  >
                    <span className="flex-1 min-w-0 break-words">{c.title}</span>
                    <button
                      type="button"
                      onClick={() => removeCard(i, k)}
                      className="opacity-0 group-hover:opacity-100 text-subtle hover:text-danger"
                      aria-label="Remove card"
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" iconLeft={<RotateCcw size={14} />} onClick={generate}>
            Regenerate
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onPlan(null)}>
            Change description
          </Button>
        </div>
        <AiNote>Remove what you don't need, then create. You can edit everything later.</AiNote>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="goal">What's this board for?</Label>
        <Textarea
          id="goal"
          autoFocus
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
          }}
          placeholder="e.g. Launch our new website in 6 weeks — design, content, development and QA"
        />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {EXAMPLES.map((x) => (
            <button
              key={x}
              type="button"
              onClick={() => setGoal(x)}
              className="rounded-full border border-line bg-inset px-2.5 py-0.5 text-xs text-muted hover:text-ink hover:border-rule"
            >
              {x}
            </button>
          ))}
        </div>
      </div>
      <FieldError>{err}</FieldError>
      <AiButton size="md" onClick={generate} className="w-full">
        Generate board
      </AiButton>
      <AiNote>Works in Arabic or English.</AiNote>
    </div>
  );
}
