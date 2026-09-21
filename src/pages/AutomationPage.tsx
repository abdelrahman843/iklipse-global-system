import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Play, Pencil, Trash2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import {
  deleteRule,
  listRules,
  recentRuns,
  toggleRule,
  upsertRule,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRule,
  type AutomationTrigger,
} from "@/lib/pm/automationApi";
import { fetchBoardBundle } from "@/lib/pm/boardApi";

const TRIGGER_OPTIONS: { value: AutomationTrigger["kind"]; label: string }[] = [
  { value: "card.created", label: "When a card is created" },
  { value: "card.moved", label: "When a card is moved" },
  { value: "card.archived", label: "When a card is archived" },
  { value: "card.due_completed", label: "When a due date is marked complete" },
];

const CONDITION_OPTIONS: { value: AutomationCondition["kind"]; label: string }[] = [
  { value: "has_label", label: "has label" },
  { value: "has_member", label: "has member" },
  { value: "in_list", label: "is in list" },
  { value: "due_incomplete", label: "due is incomplete" },
];

const ACTION_OPTIONS: { value: AutomationAction["kind"]; label: string }[] = [
  { value: "move_to_list", label: "Move to list" },
  { value: "add_label", label: "Add label" },
  { value: "remove_label", label: "Remove label" },
  { value: "add_member", label: "Add member" },
  { value: "remove_member", label: "Remove member" },
  { value: "complete_due", label: "Mark due complete" },
  { value: "archive", label: "Archive card" },
  { value: "restore", label: "Restore card" },
  { value: "add_comment", label: "Add comment" },
  { value: "rename", label: "Rename card" },
];

export function AutomationPage() {
  const { boardId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const board = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => fetchBoardBundle(boardId),
    enabled: !!boardId,
  });
  const rules = useQuery({
    queryKey: ["rules", boardId],
    queryFn: () => listRules(boardId),
    enabled: !!boardId,
  });
  const runs = useQuery({
    queryKey: ["rule-runs", boardId],
    queryFn: () => recentRuns(boardId, 30),
    enabled: !!boardId,
  });

  const [editing, setEditing] = useState<Partial<AutomationRule> | null>(null);

  const save = useMutation({
    mutationFn: (r: Parameters<typeof upsertRule>[0]) => upsertRule(r),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rules", boardId] });
      toast.push({ kind: "success", title: "Rule saved" });
      setEditing(null);
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Save failed", description: e.message }),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules", boardId] }),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => toggleRule(v.id, v.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules", boardId] }),
  });

  const boardBundle = board.data;

  if (board.isLoading || rules.isLoading) return <PageSpinner />;
  if (!boardBundle)
    return (
      <div className="p-6">
        <EmptyState title="Board not found" />
      </div>
    );

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <Link to={`/pm/boards/${boardId}`} className="text-subtle hover:text-ink">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-ink">Automation</h1>
          <p className="text-sm text-muted">Trigger-based rules for <span className="font-medium">{boardBundle.board.title}</span>.</p>
        </div>
        {can("pm.manage_automation") && (
          <Button
            variant="primary"
            iconLeft={<Plus size={16} />}
            onClick={() =>
              setEditing({
                board_id: boardId,
                name: "New rule",
                trigger: { kind: "card.moved" },
                conditions: [],
                actions: [],
                is_enabled: true,
              })
            }
          >
            New rule
          </Button>
        )}
      </div>

      {(rules.data ?? []).length === 0 ? (
        <EmptyState
          title="No automation rules yet."
          description="Rules react to events on this board. Cascades stop after depth 3, so runaway chains can't happen."
        />
      ) : (
        <ul className="space-y-2">
          {(rules.data ?? []).map((r) => (
            <li key={r.id} className="rounded-lg border border-border bg-white shadow-card p-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => can("pm.manage_automation") && toggle.mutate({ id: r.id, enabled: !r.is_enabled })}
                  className={
                    "h-5 w-9 rounded-full transition-colors " + (r.is_enabled ? "bg-success" : "bg-border")
                  }
                  aria-label={r.is_enabled ? "Disable" : "Enable"}
                  disabled={!can("pm.manage_automation")}
                >
                  <span
                    className={
                      "block h-4 w-4 bg-white rounded-full shadow transition-transform " +
                      (r.is_enabled ? "translate-x-4" : "translate-x-0.5")
                    }
                  />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink truncate">{r.name}</div>
                  <div className="text-xs text-subtle">
                    Trigger: <span className="text-muted">{r.trigger.kind}</span> · Actions:{" "}
                    <span className="text-muted">{r.actions.length}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft={<Pencil size={14} />}
                  onClick={() => setEditing(r)}
                  disabled={!can("pm.manage_automation")}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft={<Trash2 size={14} />}
                  onClick={() => {
                    if (confirm("Delete this rule?")) del.mutate(r.id);
                  }}
                  disabled={!can("pm.manage_automation")}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-sm font-semibold text-ink mt-6 mb-2 flex items-center gap-2">
        <Play size={14} /> Recent runs
      </h2>
      {(runs.data ?? []).length === 0 ? (
        <p className="text-sm text-subtle">Nothing has run yet.</p>
      ) : (
        <ul className="rounded-lg border border-border bg-white shadow-card divide-y divide-line text-sm">
          {(runs.data ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-3 py-2">
              <Badge
                tone={r.status === "ok" ? "success" : r.status === "error" ? "danger" : "neutral"}
              >
                {r.status}
              </Badge>
              <div className="flex-1 text-muted truncate">
                Rule <span className="font-mono text-xs">{r.rule_id.slice(0, 8)}</span>
                {r.card_id && (
                  <>
                    {" "}on card <span className="font-mono text-xs">{r.card_id.slice(0, 8)}</span>
                  </>
                )}
                {r.detail ? <> — {JSON.stringify(r.detail).slice(0, 60)}</> : null}
              </div>
              <div className="text-xs text-subtle">{relativeTime(r.created_at)}</div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <RuleEditor
          rule={editing}
          onClose={() => setEditing(null)}
          onSave={(r) => save.mutate(r)}
          board={boardBundle}
        />
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  onClose,
  onSave,
  board,
}: {
  rule: Partial<AutomationRule>;
  onClose: () => void;
  onSave: (r: Parameters<typeof upsertRule>[0]) => void;
  board: NonNullable<ReturnType<typeof fetchBoardBundle> extends Promise<infer T> ? T : never>;
}) {
  const [name, setName] = useState(rule.name ?? "New rule");
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger["kind"]>(
    rule.trigger?.kind ?? "card.moved",
  );
  const [conditions, setConditions] = useState<AutomationCondition[]>(rule.conditions ?? []);
  const [actions, setActions] = useState<AutomationAction[]>(rule.actions ?? []);
  const [enabled, setEnabled] = useState(rule.is_enabled ?? true);

  const listChoices = useMemo(
    () => board.lists.map((l) => ({ value: l.id, label: l.title })),
    [board],
  );
  const labelChoices = useMemo(
    () => board.labels.map((l) => ({ value: l.id, label: l.name || "(unnamed)" })),
    [board],
  );
  const memberChoices = useMemo(
    () => board.members.map((m) => ({ value: m.id, label: m.display_name })),
    [board],
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={rule.id ? "Edit rule" : "New rule"}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              onSave({
                id: rule.id,
                board_id: rule.board_id!,
                name,
                trigger: { kind: triggerKind },
                conditions,
                actions,
                is_enabled: enabled,
              })
            }
          >
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="rule-name">Rule name</Label>
          <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="rule-trigger">Trigger</Label>
          <select
            id="rule-trigger"
            className="w-full border border-border rounded-md h-9 px-2 bg-white"
            value={triggerKind}
            onChange={(e) => setTriggerKind(e.target.value as AutomationTrigger["kind"])}
          >
            {TRIGGER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <ConditionsEditor
          value={conditions}
          onChange={setConditions}
          lists={listChoices}
          labels={labelChoices}
          members={memberChoices}
        />

        <ActionsEditor
          value={actions}
          onChange={setActions}
          lists={listChoices}
          labels={labelChoices}
          members={memberChoices}
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-accent"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </div>
    </Modal>
  );
}

interface Choice {
  value: string;
  label: string;
}

function ConditionsEditor({
  value,
  onChange,
  lists,
  labels,
  members,
}: {
  value: AutomationCondition[];
  onChange: (v: AutomationCondition[]) => void;
  lists: Choice[];
  labels: Choice[];
  members: Choice[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Label>Conditions (all must match)</Label>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Plus size={12} />}
          onClick={() => onChange([...value, { kind: "has_label", args: {} }])}
        >
          Add
        </Button>
      </div>
      <div className="space-y-2">
        {value.length === 0 && <div className="text-xs text-subtle">Runs on every trigger.</div>}
        {value.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <ChevronDown size={12} className="text-subtle" />
            <select
              className="border border-border rounded-md h-8 px-2 bg-white text-sm"
              value={c.kind}
              onChange={(e) =>
                onChange(value.map((x, j) => (j === i ? { kind: e.target.value as AutomationCondition["kind"], args: {} } : x)))
              }
            >
              {CONDITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ArgPicker
              kind={c.kind}
              args={c.args ?? {}}
              onChange={(args) => onChange(value.map((x, j) => (j === i ? { ...x, args } : x)))}
              lists={lists}
              labels={labels}
              members={members}
            />
            <button
              className="text-subtle hover:text-danger p-1 rounded"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              aria-label="Remove"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionsEditor({
  value,
  onChange,
  lists,
  labels,
  members,
}: {
  value: AutomationAction[];
  onChange: (v: AutomationAction[]) => void;
  lists: Choice[];
  labels: Choice[];
  members: Choice[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Label>Actions (in order)</Label>
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<Plus size={12} />}
          onClick={() => onChange([...value, { kind: "move_to_list", args: {} }])}
        >
          Add
        </Button>
      </div>
      <div className="space-y-2">
        {value.length === 0 && <div className="text-xs text-subtle">Add at least one action.</div>}
        {value.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-subtle w-4">{i + 1}.</span>
            <select
              className="border border-border rounded-md h-8 px-2 bg-white text-sm"
              value={a.kind}
              onChange={(e) =>
                onChange(
                  value.map((x, j) =>
                    j === i ? { kind: e.target.value as AutomationAction["kind"], args: {} } : x,
                  ),
                )
              }
            >
              {ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ArgPicker
              kind={a.kind}
              args={a.args ?? {}}
              onChange={(args) => onChange(value.map((x, j) => (j === i ? { ...x, args } : x)))}
              lists={lists}
              labels={labels}
              members={members}
              actionMode
            />
            <button
              className="text-subtle hover:text-danger p-1 rounded"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              aria-label="Remove"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArgPicker({
  kind,
  args,
  onChange,
  lists,
  labels,
  members,
  actionMode,
}: {
  kind: string;
  args: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  lists: Choice[];
  labels: Choice[];
  members: Choice[];
  actionMode?: boolean;
}) {
  if (kind === "has_label" || kind === "add_label" || kind === "remove_label") {
    return <Pick label="label" choices={labels} value={args.label_id ?? ""} field="label_id" onChange={onChange} args={args} />;
  }
  if (kind === "has_member" || kind === "add_member" || kind === "remove_member") {
    return <Pick label="member" choices={members} value={args.user_id ?? ""} field="user_id" onChange={onChange} args={args} />;
  }
  if (kind === "in_list" || kind === "move_to_list") {
    return <Pick label="list" choices={lists} value={args.list_id ?? ""} field="list_id" onChange={onChange} args={args} />;
  }
  if (actionMode && (kind === "add_comment" || kind === "rename" || kind === "set_description")) {
    const field = kind === "add_comment" ? "body" : kind === "rename" ? "title" : "description";
    const Comp = kind === "set_description" ? Textarea : Input;
    return (
      <Comp
        placeholder={field}
        className="text-sm h-8"
        rows={kind === "set_description" ? 2 : undefined}
        defaultValue={args[field] ?? ""}
        onBlur={(e) =>
          onChange({ ...args, [field]: (e.target as HTMLInputElement).value })
        }
      />
    );
  }
  return null;
}

function Pick({
  label,
  choices,
  value,
  field,
  onChange,
  args,
}: {
  label: string;
  choices: Choice[];
  value: string;
  field: string;
  onChange: (v: Record<string, string>) => void;
  args: Record<string, string>;
}) {
  return (
    <select
      className="border border-border rounded-md h-8 px-2 bg-white text-sm"
      value={value}
      onChange={(e) => onChange({ ...args, [field]: e.target.value })}
    >
      <option value="">Select {label}…</option>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
