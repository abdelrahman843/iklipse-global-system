import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  CheckCircle2,
  CircleSlash,
  Copy,
  FilePlus2,
  MoveRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { useBoardAccess } from "@/lib/pm/boardAccess";
import { useBoardRealtime } from "@/lib/pm/useBoardRealtime";
import { cn } from "@/lib/cn";
import {
  deleteRule,
  listRules,
  recentRuns,
  toggleRule,
  upsertRule,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRule,
  type AutomationRun,
  type AutomationTrigger,
} from "@/lib/pm/automationApi";
import { fetchBoardBundle, type BoardBundle } from "@/lib/pm/boardApi";

const TRIGGER_OPTIONS: { value: AutomationTrigger["kind"]; label: string; short: string; icon: React.ReactNode }[] = [
  { value: "card.created", label: "When a card is created", short: "Card created", icon: <FilePlus2 size={16} /> },
  { value: "card.moved", label: "When a card is moved", short: "Card moved", icon: <MoveRight size={16} /> },
  { value: "card.archived", label: "When a card is archived", short: "Card archived", icon: <Archive size={16} /> },
  { value: "card.due_completed", label: "When a due date is marked complete", short: "Due completed", icon: <CheckCircle2 size={16} /> },
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
  { value: "set_description", label: "Set description" },
];

// Which arg each kind needs; kinds not listed take no argument.
const ARG_FIELD: Record<string, string> = {
  has_label: "label_id",
  add_label: "label_id",
  remove_label: "label_id",
  has_member: "user_id",
  add_member: "user_id",
  remove_member: "user_id",
  in_list: "list_id",
  move_to_list: "list_id",
  add_comment: "body",
  rename: "title",
  set_description: "description",
};

const selectCls =
  "border border-border rounded-md h-8 px-2 bg-surface text-sm text-ink min-w-0 outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring disabled:bg-inset transition-[border-color,box-shadow] duration-150";

type Names = { list: Map<string, string>; label: Map<string, string>; member: Map<string, string> };

function argName(kind: string, args: Record<string, string> | undefined, n: Names) {
  const field = ARG_FIELD[kind];
  const v = field ? args?.[field] : undefined;
  if (!field) return null;
  if (!v) return "…";
  if (field === "list_id") return n.list.get(v) ?? "deleted list";
  if (field === "label_id") return n.label.get(v) || "unnamed label";
  if (field === "user_id") return n.member.get(v) ?? "removed member";
  return `“${v.length > 24 ? v.slice(0, 24) + "…" : v}”`;
}

export function AutomationPage() {
  const { boardId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useBoardAccess(boardId);
  // Live rule list and run log (plus the board bundle this page reads).
  useBoardRealtime(boardId || undefined);
  const canManage = can("pm.manage_automation");

  const board = useQuery({ queryKey: ["board", boardId], queryFn: () => fetchBoardBundle(boardId), enabled: !!boardId });
  const rules = useQuery({ queryKey: ["rules", boardId], queryFn: () => listRules(boardId), enabled: !!boardId });
  const runs = useQuery({ queryKey: ["rule-runs", boardId], queryFn: () => recentRuns(boardId, 40), enabled: !!boardId });

  const [editing, setEditing] = useState<Partial<AutomationRule> | null>(null);
  const [runFilter, setRunFilter] = useState<"all" | AutomationRun["status"]>("all");

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rules", boardId] });
      toast.push({ kind: "info", title: "Rule deleted" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Delete failed", description: e.message }),
  });

  // Optimistic so the switch flips the instant it's clicked.
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => toggleRule(v.id, v.enabled),
    onMutate: (v) =>
      qc.setQueryData<AutomationRule[]>(["rules", boardId], (rs) =>
        rs?.map((r) => (r.id === v.id ? { ...r, is_enabled: v.enabled } : r)),
      ),
    onError: (e: Error) => toast.push({ kind: "error", title: "Update failed", description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["rules", boardId] }),
  });

  const bundle = board.data;
  const names = useMemo<Names>(
    () => ({
      list: new Map((bundle?.lists ?? []).map((l) => [l.id, l.title])),
      label: new Map((bundle?.labels ?? []).map((l) => [l.id, l.name])),
      member: new Map((bundle?.members ?? []).map((m) => [m.id, m.display_name])),
    }),
    [bundle],
  );
  const ruleById = useMemo(() => new Map((rules.data ?? []).map((r) => [r.id, r])), [rules.data]);
  const cardTitle = useMemo(() => new Map((bundle?.cards ?? []).map((c) => [c.id, c.title])), [bundle]);

  if (board.isLoading || rules.isLoading) return <PageSpinner />;
  if (!bundle)
    return (
      <div className="p-6">
        <EmptyState title="Board not found" />
      </div>
    );

  const ruleList = rules.data ?? [];
  const runList = (runs.data ?? []).filter((r) => runFilter === "all" || r.status === runFilter);
  const newRule = (): Partial<AutomationRule> => ({
    board_id: boardId,
    name: "",
    trigger: { kind: "card.moved" },
    conditions: [],
    actions: [],
    is_enabled: true,
  });

  return (
    <div className="h-full overflow-auto">
      <div className="p-3 sm:p-4 md:p-6 max-w-4xl mx-auto view-enter">
        <div className="flex items-start sm:items-center gap-3 mb-5">
          <Link
            to={`/pm/boards/${boardId}`}
            className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-inset transition-colors shrink-0"
            aria-label="Back to board"
          >
            <ArrowLeft size={18} />
          </Link>
          <span className="h-10 w-10 rounded-lg bg-accent-soft text-accent grid place-items-center shrink-0">
            <Zap size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Automation</h1>
            <p className="text-sm text-muted truncate">
              Rules for <span className="font-medium text-ink">{bundle.board.title}</span>
              {ruleList.length > 0 && (
                <> · {ruleList.filter((r) => r.is_enabled).length} of {ruleList.length} active</>
              )}
            </p>
          </div>
          {canManage && (
            <Button variant="primary" size="sm" iconLeft={<Plus size={16} />} className="shrink-0" onClick={() => setEditing(newRule())}>
              <span className="hidden sm:inline">New rule</span>
              <span className="sm:hidden">New</span>
            </Button>
          )}
        </div>

        {ruleList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-rule">
            <EmptyState
              icon={<Zap size={22} />}
              title="No automation rules yet"
              description="Rules react to events on this board, e.g. when a card moves into Done, mark its due date complete. Chains stop after 3 levels, so loops can't run away."
              action={
                canManage && (
                  <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setEditing(newRule())}>
                    Create your first rule
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <ul className="space-y-2">
            {ruleList.map((r, i) => {
              const trig = TRIGGER_OPTIONS.find((t) => t.value === r.trigger.kind);
              const into = r.trigger.filter?.checks?.find((c) => c.kind === "in_list")?.args?.list_id;
              return (
                <li
                  key={r.id}
                  style={{ "--i": i } as React.CSSProperties}
                  className={cn(
                    "rise group rounded-lg border bg-surface shadow-card p-3 sm:p-4 transition-[opacity,box-shadow,border-color] duration-200 hover:shadow-pop",
                    r.is_enabled ? "border-border" : "border-border opacity-60 hover:opacity-90",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Switch
                      on={r.is_enabled}
                      disabled={!canManage}
                      onChange={(on) => toggle.mutate({ id: r.id, enabled: on })}
                      label={r.is_enabled ? "Disable rule" : "Enable rule"}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-ink truncate">{r.name || "Untitled rule"}</div>
                      {/* Plain-language summary: WHEN … IF … THEN … */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        <Tag tone="when">When</Tag>
                        <Chip icon={trig?.icon}>
                          {trig?.short ?? r.trigger.kind}
                          {into && <> into {names.list.get(into) ?? "deleted list"}</>}
                        </Chip>
                        {r.conditions.length > 0 && <Tag tone="if">If</Tag>}
                        {r.conditions.map((c, j) => (
                          <Chip key={j}>
                            {CONDITION_OPTIONS.find((o) => o.value === c.kind)?.label} {argName(c.kind, c.args, names)}
                          </Chip>
                        ))}
                        <Tag tone="then">Then</Tag>
                        {r.actions.length === 0 ? (
                          <span className="text-danger">no actions</span>
                        ) : (
                          r.actions.map((a, j) => (
                            <Chip key={j}>
                              {ACTION_OPTIONS.find((o) => o.value === a.kind)?.label ?? a.kind} {argName(a.kind, a.args, names)}
                            </Chip>
                          ))
                        )}
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-0.5 sm:opacity-60 sm:group-hover:opacity-100 transition-opacity">
                        <IconBtn label="Edit" onClick={() => setEditing(r)}>
                          <Pencil size={14} />
                        </IconBtn>
                        <IconBtn
                          label="Duplicate"
                          onClick={() => setEditing({ ...r, id: undefined, name: `${r.name} (copy)` })}
                        >
                          <Copy size={14} />
                        </IconBtn>
                        <IconBtn
                          label="Delete"
                          danger
                          onClick={() => confirm(`Delete rule "${r.name}"?`) && del.mutate(r.id)}
                        >
                          <Trash2 size={14} />
                        </IconBtn>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Run log */}
        <div className="mt-8 mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-ink mr-auto">Recent runs</h2>
          <div className="inline-flex items-center gap-1 rounded-lg bg-inset border border-line p-1">
            {(["all", "ok", "skipped", "error"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setRunFilter(k)}
                className={cn(
                  "h-8 px-3 rounded-md text-sm font-medium capitalize transition-[background-color,color,box-shadow] duration-150",
                  runFilter === k ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
                )}
              >
                {k}
              </button>
            ))}
          </div>
          <IconBtn label="Refresh" onClick={() => runs.refetch()}>
            <RefreshCw size={14} className={cn(runs.isFetching && "animate-spin")} />
          </IconBtn>
        </div>
        {runList.length === 0 ? (
          <p className="text-sm text-subtle rounded-lg border border-dashed border-rule px-4 py-6 text-center">
            {runFilter === "all" ? "Nothing has run yet." : `No ${runFilter} runs.`}
          </p>
        ) : (
          <ul className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line text-sm overflow-hidden">
            {runList.map((r, i) => (
              <li
                key={r.id}
                style={{ "--i": i } as React.CSSProperties}
                className="rise flex items-center gap-3 px-3 py-2.5 hover:bg-inset transition-colors"
              >
                <RunIcon status={r.status} />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-ink">
                    <span className="font-medium">{ruleById.get(r.rule_id)?.name ?? "Deleted rule"}</span>
                    {r.card_id && (
                      <span className="text-muted"> on {cardTitle.get(r.card_id) ?? "an archived card"}</span>
                    )}
                  </div>
                  <div className="text-xs text-subtle truncate">{runDetail(r)}</div>
                </div>
                <div className="text-xs text-subtle whitespace-nowrap" title={new Date(r.created_at).toLocaleString()}>
                  {relativeTime(r.created_at)}
                </div>
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <RuleEditor
            rule={editing}
            saving={save.isPending}
            onClose={() => setEditing(null)}
            onSave={(r) => save.mutate(r)}
            board={bundle}
          />
        )}
      </div>
    </div>
  );
}

function runDetail(r: AutomationRun) {
  const d = (r.detail ?? {}) as Record<string, string>;
  if (r.status === "error") return d.error ? `Error: ${d.error}` : "Failed";
  if (r.status === "skipped") return d.reason === "trigger_filter" ? "Skipped: trigger filter didn't match" : "Skipped: conditions didn't match";
  return r.depth > 0 ? `Ran (chained, level ${r.depth + 1})` : "Ran successfully";
}

function RunIcon({ status }: { status: AutomationRun["status"] }) {
  if (status === "ok") return <CheckCircle2 size={16} className="text-success shrink-0" />;
  if (status === "error") return <AlertCircle size={16} className="text-danger shrink-0" />;
  return <CircleSlash size={16} className="text-subtle shrink-0" />;
}

function Tag({ tone, children }: { tone: "when" | "if" | "then"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "uppercase tracking-eyebrow text-[10px] font-bold px-1.5 py-0.5 rounded-md",
        tone === "when" && "bg-accent-soft text-accent",
        tone === "if" && "bg-warn/10 text-warn",
        tone === "then" && "bg-success/10 text-success",
      )}
    >
      {children}
    </span>
  );
}

function Chip({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-inset border border-line text-ink max-w-full">
      {icon && <span className="text-muted [&>svg]:w-3 [&>svg]:h-3">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "h-8 w-8 grid place-items-center rounded-md text-muted transition-colors active:scale-95",
        danger ? "hover:text-danger hover:bg-danger/10" : "hover:text-ink hover:bg-inset",
      )}
    >
      {children}
    </button>
  );
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:cursor-not-allowed",
        on ? "bg-accent" : "bg-rule",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-pop",
          on && "translate-x-4",
        )}
      />
    </button>
  );
}

// ================================================================ Editor ==

interface Choice {
  value: string;
  label: string;
}

export function RuleEditor({
  rule,
  saving,
  onClose,
  onSave,
  board,
}: {
  rule: Partial<AutomationRule>;
  saving: boolean;
  onClose: () => void;
  onSave: (r: Parameters<typeof upsertRule>[0]) => void;
  board: BoardBundle;
}) {
  const [name, setName] = useState(rule.name ?? "");
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger["kind"]>(rule.trigger?.kind ?? "card.moved");
  const [triggerList, setTriggerList] = useState(
    rule.trigger?.filter?.checks?.find((c) => c.kind === "in_list")?.args?.list_id ?? "",
  );
  const [conditions, setConditions] = useState<AutomationCondition[]>(rule.conditions ?? []);
  const [actions, setActions] = useState<AutomationAction[]>(rule.actions ?? []);
  const [enabled, setEnabled] = useState(rule.is_enabled ?? true);
  const [tried, setTried] = useState(false);

  const choices = useMemo(
    () => ({
      lists: board.lists.map((l) => ({ value: l.id, label: l.title })),
      labels: board.labels.map((l) => ({ value: l.id, label: l.name || "(unnamed)" })),
      members: board.members.map((m) => ({ value: m.id, label: m.display_name })),
    }),
    [board],
  );

  const missing = (x: { kind: string; args?: Record<string, string> }) => {
    const f = ARG_FIELD[x.kind];
    return !!f && !x.args?.[f]?.trim();
  };
  const problems = [
    !name.trim() && "Give the rule a name.",
    actions.length === 0 && "Add at least one action.",
    (conditions.some(missing) || actions.some(missing)) && "Fill in every highlighted field.",
  ].filter(Boolean) as string[];

  const submit = () => {
    setTried(true);
    if (problems.length) return;
    const canFilter = triggerKind === "card.moved" || triggerKind === "card.created";
    onSave({
      id: rule.id,
      board_id: rule.board_id!,
      name: name.trim(),
      trigger:
        canFilter && triggerList
          ? { kind: triggerKind, filter: { checks: [{ kind: "in_list", args: { list_id: triggerList } }] } }
          : { kind: triggerKind },
      conditions,
      actions,
      is_enabled: enabled,
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={rule.id ? "Edit rule" : "New rule"}
      size="lg"
      fitViewport
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-sm text-ink cursor-pointer select-none">
            <Switch on={enabled} onChange={setEnabled} label="Enabled" />
            Enabled
          </label>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            Save rule
          </Button>
        </>
      }
    >
      {/* Body scrolls on its own so the Save footer never leaves the screen. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4">
      <div className="space-y-5">
        <div>
          <Label htmlFor="rule-name">Rule name</Label>
          <Input
            id="rule-name"
            autoFocus={!rule.id}
            placeholder="e.g. Close out cards moved to Done"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={cn(tried && !name.trim() && "border-danger")}
          />
        </div>

        <Step n={1} title="When…">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TRIGGER_OPTIONS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTriggerKind(t.value)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-sm transition-all duration-150",
                  triggerKind === t.value
                    ? "border-accent bg-accent-soft text-ink ring-1 ring-accent"
                    : "border-border bg-surface text-muted hover:text-ink hover:border-rule",
                )}
              >
                <span className={cn("shrink-0", triggerKind === t.value ? "text-accent" : "text-subtle")}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
          {(triggerKind === "card.moved" || triggerKind === "card.created") && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted animate-slide-down">
              {triggerKind === "card.moved" ? "into" : "in"}
              <select className={selectCls} value={triggerList} onChange={(e) => setTriggerList(e.target.value)}>
                <option value="">any list</option>
                {choices.lists.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </Step>

        <Step
          n={2}
          title="If… (optional, all must match)"
          action={
            <Button size="sm" variant="ghost" iconLeft={<Plus size={12} />} onClick={() => setConditions([...conditions, { kind: "has_label", args: {} }])}>
              Condition
            </Button>
          }
        >
          {conditions.length === 0 && <div className="text-xs text-subtle">No conditions, runs on every trigger.</div>}
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <Row key={i} prefix={i === 0 ? "IF" : "AND"} onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}>
                <select
                  className={cn(selectCls, "flex-1 sm:flex-none")}
                  value={c.kind}
                  onChange={(e) =>
                    setConditions(conditions.map((x, j) => (j === i ? { kind: e.target.value as AutomationCondition["kind"], args: {} } : x)))
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
                  invalid={tried && missing(c)}
                  onChange={(args) => setConditions(conditions.map((x, j) => (j === i ? { ...x, args } : x)))}
                  {...choices}
                />
              </Row>
            ))}
          </div>
        </Step>

        <Step
          n={3}
          title="Then… (in order)"
          action={
            <Button size="sm" variant="ghost" iconLeft={<Plus size={12} />} onClick={() => setActions([...actions, { kind: "move_to_list", args: {} }])}>
              Action
            </Button>
          }
        >
          {actions.length === 0 && (
            <div className={cn("text-xs", tried ? "text-danger" : "text-subtle")}>Add at least one action.</div>
          )}
          <div className="space-y-2">
            {actions.map((a, i) => (
              <Row key={i} prefix={`${i + 1}`} onRemove={() => setActions(actions.filter((_, j) => j !== i))}>
                <select
                  className={cn(selectCls, "flex-1 sm:flex-none")}
                  value={a.kind}
                  onChange={(e) =>
                    setActions(actions.map((x, j) => (j === i ? { kind: e.target.value as AutomationAction["kind"], args: {} } : x)))
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
                  invalid={tried && missing(a)}
                  onChange={(args) => setActions(actions.map((x, j) => (j === i ? { ...x, args } : x)))}
                  {...choices}
                />
              </Row>
            ))}
          </div>
        </Step>

        {tried && problems.length > 0 && (
          <div className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger animate-slide-down">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
      </div>
      </div>
    </Modal>
  );
}

function Step({ n, title, action, children }: { n: number; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className="h-5 w-5 rounded-full bg-ink text-surface text-[11px] font-bold grid place-items-center">{n}</span>
        <h3 className="flex-1 text-sm font-semibold text-ink">{title}</h3>
        {action}
      </div>
      <div className="pl-7">{children}</div>
    </section>
  );
}

function Row({ prefix, onRemove, children }: { prefix: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="group/row flex items-start gap-2 rounded-md p-1.5 -mx-1.5 bg-inset/40 border border-line animate-slide-down">
      <span className="w-9 shrink-0 h-8 grid place-items-center text-[10px] font-bold text-subtle tracking-eyebrow">{prefix}</span>
      {/* Fields wrap among themselves; the delete button stays pinned right. */}
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">{children}</div>
      <button
        className="h-8 w-8 grid place-items-center text-muted hover:text-danger hover:bg-danger/10 rounded-md shrink-0 transition-colors"
        onClick={onRemove}
        aria-label="Remove"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function ArgPicker({
  kind,
  args,
  onChange,
  invalid,
  lists,
  labels,
  members,
}: {
  kind: string;
  args: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  invalid?: boolean;
  lists: Choice[];
  labels: Choice[];
  members: Choice[];
}) {
  const field = ARG_FIELD[kind];
  if (!field) return null;
  const bad = invalid && "border-danger";
  if (field === "label_id" || field === "user_id" || field === "list_id") {
    const opts = field === "label_id" ? labels : field === "user_id" ? members : lists;
    const noun = field === "label_id" ? "label" : field === "user_id" ? "member" : "list";
    return (
      <select
        className={cn(selectCls, "flex-1 sm:flex-none", bad)}
        value={args[field] ?? ""}
        onChange={(e) => onChange({ ...args, [field]: e.target.value })}
      >
        <option value="">Select {noun}…</option>
        {opts.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  // Controlled so Save always sees the latest text — no blur needed.
  if (kind === "set_description") {
    return (
      <Textarea
        placeholder="Description"
        className={cn("text-sm basis-full", bad)}
        rows={2}
        value={args[field] ?? ""}
        onChange={(e) => onChange({ ...args, [field]: e.target.value })}
      />
    );
  }
  return (
    <Input
      placeholder={kind === "add_comment" ? "Comment text" : "New title"}
      className={cn("text-sm h-8 flex-1 min-w-[160px]", bad)}
      value={args[field] ?? ""}
      onChange={(e) => onChange({ ...args, [field]: e.target.value })}
    />
  );
}
