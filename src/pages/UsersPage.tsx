import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Wand2,
  Crown,
  Globe2,
  Lock,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  UserCog,
  UserRound,
  UserRoundX,
  KeyRound,
  Sparkles,
  Trash2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AiModel, Board, BoardRole, MemberPolicy, Profile, Role, Workspace } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError, Hint } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { AI_GRADIENT } from "@/components/ui/Ai";
import { AI_MODELS, ai, setAiKey, useAiStatus } from "@/lib/ai";
import { useToast } from "@/components/ui/Toast";
import { adminApi } from "@/lib/adminApi";
import { useAuth, WORKSPACE_ID } from "@/lib/auth";
import { useUsersRealtime } from "@/lib/pm/useBoardRealtime";
import { cn } from "@/lib/cn";
import { BOARD_ROLES, ROLE_MATRIX, WORKSPACE_ROLES, workspaceRoleLabel } from "@/lib/permissions";

// ============================================================================
// Users — Trello-style: each person gets ONE workspace role, then a role per
// board. What they can do comes from those roles (see the Roles tab), not
// from a pile of per-user checkboxes.
// ============================================================================

interface Row extends Profile {
  boards: Record<string, BoardRole>;
}

interface UsersData {
  rows: Row[];
  boards: Pick<Board, "id" | "title" | "visibility">[];
}

async function fetchUsers(): Promise<UsersData> {
  const [profiles, members, boards] = await Promise.all([
    supabase.from("profile").select("*").order("created_at", { ascending: false }),
    supabase.from("board_member").select("board_id, user_id, role"),
    supabase.from("board").select("id, title, visibility").eq("is_archived", false).order("title"),
  ]);
  if (profiles.error) throw profiles.error;
  if (members.error) throw members.error;
  if (boards.error) throw boards.error;
  const byUser = new Map<string, Record<string, BoardRole>>();
  for (const m of (members.data ?? []) as { board_id: string; user_id: string; role: BoardRole }[]) {
    const rec = byUser.get(m.user_id) ?? {};
    rec[m.board_id] = m.role;
    byUser.set(m.user_id, rec);
  }
  return {
    rows: ((profiles.data ?? []) as Profile[]).map((p) => ({ ...p, boards: byUser.get(p.id) ?? {} })),
    boards: (boards.data ?? []) as UsersData["boards"],
  };
}

const ROLE_ICON: Record<Role, React.ReactNode> = {
  admin: <Crown size={15} />,
  member: <UserRound size={15} />,
  guest: <UserRoundX size={15} />,
};

function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge tone={role === "admin" ? "accent" : role === "guest" ? "warn" : "neutral"}>
      {ROLE_ICON[role]}
      {workspaceRoleLabel(role)}
    </Badge>
  );
}

type Tab = "members" | "roles";

export function UsersPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
  const toast = useToast();
  useUsersRealtime(true);

  const [tab, setTab] = useState<Tab>("members");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.rows ?? []).filter(
      (r) =>
        (roleFilter === "all" || r.role === roleFilter) &&
        (!q || r.display_name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)),
    );
  }, [data, query, roleFilter]);

  const counts = useMemo(() => {
    const c: Record<Role, number> = { admin: 0, member: 0, guest: 0 };
    for (const r of data?.rows ?? []) c[r.role]++;
    return c;
  }, [data]);

  const toggleActive = useMutation({
    mutationFn: (r: Row) => adminApi.updateMember({ user_id: r.id, is_active: !r.is_active }),
    onSuccess: (_, r) => {
      toast.push({ kind: "success", title: r.is_active ? "Member deactivated" : "Member reactivated" });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Update failed", description: e.message }),
  });

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load users" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6 max-w-6xl mx-auto">
        <div className="flex items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <div className="eyebrow text-subtle mb-1">Administration</div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Users</h1>
            <p className="text-sm text-muted mt-1 hidden sm:block">
              Give each person a workspace role, then decide which boards they're on and as what.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus size={16} />}
            onClick={() => setCreating(true)}
            className="shrink-0"
          >
            <span className="hidden sm:inline">Add member</span>
            <span className="sm:hidden">Add</span>
          </Button>
        </div>

        <div className="border-b border-border flex gap-1 mb-5">
          {(
            [
              ["members", "Members"],
              ["roles", "Roles & settings"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "relative h-10 px-3 text-sm font-medium transition-colors",
                tab === t ? "text-ink" : "text-muted hover:text-ink",
              )}
            >
              {label}
              <span
                className={cn(
                  "absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent transition-transform duration-200",
                  tab === t ? "scale-x-100" : "scale-x-0",
                )}
              />
            </button>
          ))}
        </div>

        {tab === "roles" ? (
          <div key="roles" className="view-enter">
            <RolesTab />
          </div>
        ) : (
          <div key="members" className="view-enter">
            <div className="mb-4 flex flex-col sm:flex-row gap-2 sm:items-center">
              <div className="flex-1 max-w-sm flex items-center gap-2 rounded-md border border-rule bg-surface px-2.5 h-9 text-sm shadow-card focus-within:border-ink focus-within:shadow-pop transition-[border-color,box-shadow] duration-150">
                <Search size={14} className="text-subtle" />
                <input
                  className="flex-1 bg-transparent outline-none text-ink placeholder:text-subtle"
                  placeholder="Search by name or username…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Segmented<Role | "all">
                value={roleFilter}
                onChange={setRoleFilter}
                options={[
                  { value: "all", label: `All ${data?.rows.length ?? 0}` },
                  { value: "admin", label: `Admins ${counts.admin}` },
                  { value: "member", label: `Members ${counts.member}` },
                  { value: "guest", label: `Guests ${counts.guest}` },
                ]}
              />
            </div>

            <div className="rounded-lg border border-border bg-surface shadow-card overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-inset text-muted text-[11px] uppercase tracking-[0.3px] border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Member</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Workspace role</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Boards</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <EmptyState
                          title={query || roleFilter !== "all" ? "No one matches." : "No members yet"}
                          description={query || roleFilter !== "all" ? undefined : "Add your first employee to get started."}
                        />
                      </td>
                    </tr>
                  )}
                  {rows.map((r, i) => {
                    const boardCount = Object.keys(r.boards).length;
                    return (
                      <tr
                        key={r.id}
                        style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                        className={cn(
                          "rise border-t border-line align-middle hover:bg-inset transition-colors",
                          !r.is_active && "opacity-60",
                        )}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={r.display_name} src={r.avatar_url} size={30} />
                            <div className="min-w-0">
                              <div className="font-medium text-ink truncate">{r.display_name}</div>
                              <div className="text-xs text-subtle truncate">@{r.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <RoleBadge role={r.role} />
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {r.role === "admin" ? (
                            <span className="text-xs">Admin on all boards</span>
                          ) : boardCount ? (
                            <BoardChips boards={data?.boards ?? []} roles={r.boards} />
                          ) : (
                            <span className="text-xs text-subtle">
                              {r.role === "guest" ? "No boards — can't see anything yet" : "No boards yet"}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Deactivated</Badge>}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button size="sm" variant="ghost" iconLeft={<UserCog size={14} />} onClick={() => setEditing(r)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant={r.is_active ? "subtle" : "primary"}
                              iconLeft={r.is_active ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                              loading={toggleActive.isPending && toggleActive.variables?.id === r.id}
                              onClick={() => toggleActive.mutate(r)}
                            >
                              {r.is_active ? "Deactivate" : "Reactivate"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(creating || editing) && (
          <MemberFormModal
            mode={creating ? "create" : "edit"}
            member={editing ?? undefined}
            boards={data?.boards ?? []}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSaved={() => {
              setCreating(false);
              setEditing(null);
              qc.invalidateQueries({ queryKey: ["users"] });
              qc.invalidateQueries({ queryKey: ["boards"] });
              qc.invalidateQueries({ queryKey: ["board-members"] });
            }}
          />
        )}
      </div>
    </div>
  );
}

function BoardChips({ boards, roles }: { boards: UsersData["boards"]; roles: Record<string, BoardRole> }) {
  const list = boards.filter((b) => roles[b.id]);
  const shown = list.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((b) => (
        <span
          key={b.id}
          className="inline-flex items-center gap-1 max-w-[160px] rounded border border-line bg-inset px-1.5 py-0.5 text-xs text-ink"
          title={`${b.title} — ${BOARD_ROLES.find((r) => r.value === roles[b.id])?.label}`}
        >
          <span className="truncate">{b.title}</span>
          {roles[b.id] !== "normal" && (
            <span className="text-subtle shrink-0">· {roles[b.id] === "admin" ? "Admin" : "Observer"}</span>
          )}
        </span>
      ))}
      {list.length > shown.length && <span className="text-xs text-subtle">+{list.length - shown.length}</span>}
    </div>
  );
}

// ============================================================================
// Roles & settings tab
// ============================================================================

function RolesTab() {
  const { workspace, refreshWorkspace } = useAuth();
  const toast = useToast();

  const save = useMutation({
    mutationFn: async (patch: Partial<Workspace>) => {
      const { error } = await supabase.from("workspace").update(patch).eq("id", WORKSPACE_ID);
      if (error) throw error;
    },
    onSuccess: async () => {
      await refreshWorkspace();
      toast.push({ kind: "success", title: "Workspace setting saved" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  const settings: { key: keyof Workspace; title: string; hint: string; options: { value: MemberPolicy; label: string }[] }[] = [
    {
      key: "board_create_policy",
      title: "Who can create boards",
      hint: "Guests can never create boards.",
      options: [
        { value: "members", label: "Any member" },
        { value: "admins", label: "Workspace admins only" },
      ],
    },
    {
      key: "guest_policy",
      title: "Who can add guests to boards",
      hint: "Guests are people outside the company.",
      options: [
        { value: "members", label: "Anyone who can add members" },
        { value: "admins", label: "Workspace admins only" },
      ],
    },
  ];

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-semibold text-ink mb-1">Workspace roles</h2>
        <p className="text-sm text-muted mb-3">Everyone has exactly one. It decides what they can see.</p>
        <div className="grid md:grid-cols-3 gap-3">
          {WORKSPACE_ROLES.map((r, i) => (
            <div
              key={r.value}
              style={{ "--i": i } as React.CSSProperties}
              className="rise rounded-lg border border-border bg-surface shadow-card p-4"
            >
              <div className="flex items-center gap-2 font-semibold text-ink">
                <span className="h-7 w-7 rounded-md bg-accent-soft text-accent grid place-items-center">{ROLE_ICON[r.value]}</span>
                {r.label}
              </div>
              <p className="text-sm text-muted mt-2">{r.summary}</p>
              <ul className="mt-2 space-y-1">
                {r.points.map((p) => (
                  <li key={p} className="flex items-start gap-1.5 text-sm text-ink">
                    <Check size={14} className="text-success mt-0.5 shrink-0" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink mb-1">Board roles</h2>
        <p className="text-sm text-muted mb-3">
          Given per board, in the board's Share dialog or here when editing a user.
        </p>
        <div className="rounded-lg border border-border bg-surface shadow-card overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-inset text-muted text-[11px] uppercase tracking-[0.3px] border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Can…</th>
                {BOARD_ROLES.map((r) => (
                  <th key={r.value} className="px-4 py-2.5 font-semibold text-center w-[18%]">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLE_MATRIX.map((row) => (
                <tr key={row.label} className="border-t border-line">
                  <td className="px-4 py-2 text-ink">{row.label}</td>
                  {(["admin", "normal", "observer"] as const).map((k) => (
                    <td key={k} className="px-4 py-2 text-center">
                      <MatrixCell v={row[k]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink mb-1">Workspace settings</h2>
        <p className="text-sm text-muted mb-3">Apply to every board. Board-level settings live in each board's Share → Settings.</p>
        <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line">
          {settings.map((s) => (
            <div key={s.key} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink">{s.title}</div>
                <div className="text-xs text-muted">{s.hint}</div>
              </div>
              <Segmented<MemberPolicy>
                value={(workspace?.[s.key] as MemberPolicy | undefined) ?? "members"}
                options={s.options}
                disabled={!workspace || save.isPending}
                onChange={(v) => save.mutate({ [s.key]: v } as Partial<Workspace>)}
              />
            </div>
          ))}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink">Who can delete boards</div>
              <div className="text-xs text-muted">
                Deleting removes the board and all its cards forever, so it's reserved for workspace admins.
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-inset border border-line text-sm text-ink">
              <Lock size={13} className="text-muted" /> Workspace admins only
            </span>
          </div>
        </div>
      </section>

      <AiSettings />
    </div>
  );
}

// Trello/Atlassian-style: the workspace admin turns AI on for everyone and
// owns the OpenAI key. The key is write-only — stored in Supabase Vault and
// never sent back to the browser.
function AiSettings() {
  const { workspace, refreshWorkspace } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useAiStatus();
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const refresh = async () => {
    await Promise.all([refreshWorkspace(), qc.invalidateQueries({ queryKey: ["ai-status"] })]);
  };

  const save = useMutation({
    mutationFn: async (patch: Partial<Pick<Workspace, "ai_enabled" | "ai_model">>) => {
      const { error } = await supabase.from("workspace").update(patch).eq("id", WORKSPACE_ID);
      if (error) throw error;
    },
    onSuccess: async () => {
      await refresh();
      toast.push({ kind: "success", title: "AI setting saved" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  const saveKey = useMutation({
    mutationFn: (k: string | null) => setAiKey(k),
    onSuccess: async (_d, k) => {
      setKey("");
      await refresh();
      toast.push({ kind: "success", title: k ? "API key saved" : "API key removed" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save key", description: e.message }),
  });

  const test = useMutation({
    mutationFn: () => ai.ping(),
    onSuccess: () =>
      toast.push({ kind: "success", title: "Connected to OpenAI", description: `Model ${status.data?.model} answered.` }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Connection failed", description: e.message }),
  });

  const s = status.data;
  const enabled = workspace?.ai_enabled ?? false;

  return (
    <section>
      <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
        <span className={cn("grid place-items-center h-5 w-5 rounded text-white", AI_GRADIENT)}>
          <Sparkles size={12} />
        </span>
        AI assistant (OpenAI)
      </h2>
      <p className="text-sm text-muted mb-3">
        Writing help, checklists, card summaries and board generation. People only get AI on boards they can edit, and
        every result is a suggestion they have to accept.
      </p>
      <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line">
        <div className="px-4 py-3">
          <Toggle
            checked={enabled}
            disabled={!workspace || save.isPending}
            onChange={(v) => save.mutate({ ai_enabled: v })}
            label="Turn on AI for the workspace"
            hint={
              enabled && s && !s.configured
                ? "On, but it won't work until you add an API key below."
                : "Off hides every AI button for everyone."
            }
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
              <KeyRound size={14} /> OpenAI API key
              {s?.configured ? <Badge tone="success">Saved {s.key_hint}</Badge> : <Badge tone="warn">Not set</Badge>}
            </div>
            <div className="text-xs text-muted">
              From platform.openai.com → API keys. Stored encrypted in the database; nobody can read it back.
            </div>
          </div>
          <form
            className="flex items-center gap-2 w-full sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) saveKey.mutate(key.trim());
            }}
          >
            <div className="relative flex-1 sm:w-64">
              <Input
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={s?.configured ? "Paste a new key to replace" : "sk-…"}
                autoComplete="off"
                spellCheck={false}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center h-7 w-7 rounded text-muted hover:text-ink"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button type="submit" variant="primary" size="sm" loading={saveKey.isPending} disabled={!key.trim()}>
              Save
            </Button>
            {s?.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove key"
                title="Remove key"
                onClick={() =>
                  confirm("Remove the OpenAI key? AI stops working until a new key is added.") && saveKey.mutate(null)
                }
              >
                <Trash2 size={14} />
              </Button>
            )}
          </form>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink">Model</div>
            <div className="text-xs text-muted">{AI_MODELS.find((m) => m.value === workspace?.ai_model)?.hint}</div>
          </div>
          <select
            value={workspace?.ai_model ?? "gpt-4o-mini"}
            disabled={!workspace || save.isPending}
            onChange={(e) => save.mutate({ ai_model: e.target.value as AiModel })}
            className="h-9 rounded-md border border-border bg-surface px-2.5 text-sm text-ink"
          >
            {AI_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
          <div className="flex-1 min-w-0 text-xs text-muted">
            Last 30 days: <span className="text-ink font-medium">{s?.requests_30d ?? 0}</span> requests ·{" "}
            <span className="text-ink font-medium">{(s?.tokens_30d ?? 0).toLocaleString()}</span> tokens. Limit: 60
            requests per person per hour.
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={test.isPending}
            disabled={!s?.configured}
            onClick={() => test.mutate()}
          >
            Test connection
          </Button>
        </div>
      </div>
    </section>
  );
}

function MatrixCell({ v }: { v: boolean | string }) {
  if (v === true) return <Check size={16} className="inline text-success" />;
  if (v === false) return <Minus size={16} className="inline text-subtle" />;
  return <span className="text-xs text-muted">{v}</span>;
}

// ============================================================================
// Create / edit modal
// ============================================================================

type Access = BoardRole | "none";

// Same rule as the admin-create/update-member edge functions.
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;

// Company domain shown after the username (and accepted at sign-in).
export const EMAIL_DOMAIN = "@iklipseworld.com";
const stripDomain = (v: string) =>
  v.toLowerCase().endsWith(EMAIL_DOMAIN) ? v.slice(0, -EMAIL_DOMAIN.length) : v.replace(/\s/g, "");

// 16 chars from an unambiguous alphabet (no 0/O, 1/l/I), always with upper,
// lower, digit and symbol. crypto.getRandomValues — not Math.random.
function generatePassword(len = 16): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*?-_"];
  const all = sets.join("");
  const rnd = (n: number) => {
    const a = new Uint32Array(1);
    const limit = Math.floor(0x1_0000_0000 / n) * n; // reject bias
    do crypto.getRandomValues(a);
    while (a[0]! >= limit);
    return a[0]! % n;
  };
  const chars = sets.map((s) => s[rnd(s.length)]!);
  while (chars.length < len) chars.push(all[rnd(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

function PwIconBtn({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "shrink-0 h-full w-8 grid place-items-center border-l border-line text-muted hover:text-ink hover:bg-inset transition-colors",
        className,
      )}
    >
      {children}
    </button>
  );
}
const suggestUsername = (v: string) =>
  v.split("@")[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32) || "username";

function MemberFormModal({
  mode,
  member,
  boards,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  member?: Row;
  boards: UsersData["boards"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState(member?.display_name ?? "");
  const [username, setUsername] = useState(member?.username ?? "");
  const [role, setRole] = useState<Role>(member?.role ?? "member");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [access, setAccess] = useState<Record<string, Access>>(() =>
    Object.fromEntries(boards.map((b) => [b.id, member?.boards[b.id] ?? "none"])),
  );
  const [boardQ, setBoardQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const self = member?.id === user?.id;

  const shownBoards = boards.filter((b) => b.title.toLowerCase().includes(boardQ.trim().toLowerCase()));
  const onCount = Object.values(access).filter((a) => a !== "none").length;

  async function syncBoards(userId: string) {
    const before = member?.boards ?? {};
    const errors: string[] = [];
    for (const b of boards) {
      const want = access[b.id] ?? "none";
      const had = before[b.id];
      let res: { error: { message: string } | null } | null = null;
      if (want === "none" && had) {
        res = await supabase.from("board_member").delete().eq("board_id", b.id).eq("user_id", userId);
      } else if (want !== "none" && !had) {
        res = await supabase.from("board_member").insert({ board_id: b.id, user_id: userId, role: want });
      } else if (want !== "none" && had && want !== had) {
        res = await supabase.from("board_member").update({ role: want }).eq("board_id", b.id).eq("user_id", userId);
      }
      if (res?.error) errors.push(`${b.title}: ${res.error.message}`);
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);
    if (!displayName.trim() || !username.trim()) return setErr("Display name and username are required.");
    if (!USERNAME_RE.test(username.trim()))
      return setErr(
        username.includes("@")
          ? `Username can't be an email. Try "${suggestUsername(username)}" — people sign in with the username, not an email.`
          : "Username must be 3–32 characters: letters, digits, dot, dash or underscore.",
      );
    if (mode === "create" && password.length < 8) return setErr("Password must be at least 8 characters.");
    setBusy(true);
    try {
      let id = member?.id;
      if (mode === "create") {
        const res = await adminApi.createMember({
          display_name: displayName.trim(),
          username: username.trim(),
          role,
          password,
        });
        id = res.user_id;
      } else if (member) {
        await adminApi.updateMember({
          user_id: member.id,
          display_name: displayName.trim(),
          username: username.trim(),
          role: self ? undefined : role,
          new_password: password || undefined,
        });
      }
      // Workspace admins are admin everywhere — their board rows don't matter.
      if (id && role !== "admin") await syncBoards(id);
      toast.push({ kind: "success", title: mode === "create" ? "Member created" : "Member updated" });
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const setAll = (a: Access) => setAccess(Object.fromEntries(boards.map((b) => [b.id, a])));

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      fitViewport
      title={mode === "create" ? "Add member" : `Edit ${member?.display_name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => submit()} loading={busy}>
            {mode === "create" ? "Create member" : "Save changes"}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-6">
        <section className="grid gap-3 sm:gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="dn">Display name</Label>
            <Input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus={mode === "create"} />
          </div>
          <div>
            <Label htmlFor="un">Username</Label>
            {/* Type only the name; the company domain is filled in. Pasting a
                full address strips the domain automatically. */}
            <div
              className={cn(
                "flex items-center h-9 rounded-md border bg-surface text-sm transition-[border-color,box-shadow] focus-within:shadow-pop",
                username && !USERNAME_RE.test(username.trim())
                  ? "border-danger"
                  : "border-rule focus-within:border-ink",
              )}
            >
              <input
                id="un"
                className="flex-1 min-w-0 h-full bg-transparent px-3 outline-none text-ink placeholder:text-subtle"
                placeholder="shams"
                autoComplete="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(stripDomain(e.target.value))}
                aria-invalid={!!username && !USERNAME_RE.test(username.trim())}
              />
              <span className="shrink-0 h-full grid place-items-center px-2.5 border-l border-line bg-inset text-muted rounded-r-md select-none">
                {EMAIL_DOMAIN}
              </span>
            </div>
            {username.includes("@") ? (
              <Hint>
                Only the part before @ —{" "}
                <button type="button" className="text-accent hover:underline" onClick={() => setUsername(suggestUsername(username))}>
                  use “{suggestUsername(username)}”
                </button>
              </Hint>
            ) : (
              <Hint>Signs in with {username.trim() || "username"} or {username.trim() || "username"}{EMAIL_DOMAIN}</Hint>
            )}
          </div>
          <div>
            <Label htmlFor="pw">{mode === "create" ? "Password" : "Reset password"}</Label>
            <div className="flex items-center h-9 rounded-md border border-rule bg-surface text-sm focus-within:border-ink focus-within:shadow-pop transition-[border-color,box-shadow]">
              <input
                id="pw"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                className="flex-1 min-w-0 h-full bg-transparent px-3 outline-none text-ink placeholder:text-subtle font-mono"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "edit" ? "Leave blank to keep" : "Min. 8 characters"}
              />
              <PwIconBtn title={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw((v) => !v)}>
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </PwIconBtn>
              {password && (
                <PwIconBtn
                  title="Copy password"
                  onClick={() => {
                    void navigator.clipboard?.writeText(password).then(
                      () => toast.push({ kind: "success", title: "Password copied" }),
                      () => toast.push({ kind: "error", title: "Couldn't copy" }),
                    );
                  }}
                >
                  <Copy size={15} />
                </PwIconBtn>
              )}
              <PwIconBtn
                title="Generate a strong password"
                onClick={() => {
                  setPassword(generatePassword());
                  setShowPw(true);
                }}
                className="rounded-r-md"
              >
                <Wand2 size={15} />
              </PwIconBtn>
            </div>
            <Hint>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setPassword(generatePassword());
                  setShowPw(true);
                }}
              >
                Generate password
              </button>{" "}
              · copy it before saving
            </Hint>
          </div>
        </section>

        <section>
          <Label>Workspace role</Label>
          <div className="grid sm:grid-cols-3 gap-2">
            {WORKSPACE_ROLES.map((r) => {
              const active = role === r.value;
              return (
                <button
                  key={r.value}
                  type="button"
                  disabled={self && r.value !== role}
                  onClick={() => setRole(r.value)}
                  className={cn(
                    "text-left rounded-lg border px-3 py-2.5 transition-[border-color,background-color,box-shadow,transform] duration-150 active:scale-[0.99]",
                    active ? "border-accent bg-accent-soft shadow-card" : "border-border bg-surface hover:border-rule",
                    "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
                  )}
                >
                  <div className={cn("flex items-center gap-2 text-sm font-semibold", active ? "text-accent" : "text-ink")}>
                    {ROLE_ICON[r.value]}
                    {r.label}
                    {active && <Check size={14} className="ml-auto" />}
                  </div>
                  <div className="text-xs text-muted mt-1 leading-snug">{r.points.join(" · ")}</div>
                </button>
              );
            })}
          </div>
          {self && <Hint>You can't change your own role.</Hint>}
        </section>

        <section>
          <div className="flex items-end justify-between gap-2 mb-2">
            <div>
              <div className="text-sm font-medium text-ink">Board access</div>
              <div className="text-xs text-muted">
                {role === "admin"
                  ? "Workspace admins are admin on every board automatically."
                  : `${onCount} of ${boards.length} boards${role === "member" ? " · members also see workspace-visible boards and can join them" : ""}`}
              </div>
            </div>
            {role !== "admin" && boards.length > 1 && (
              <div className="flex gap-1 text-xs">
                <button type="button" className="text-accent hover:underline" onClick={() => setAll("normal")}>
                  All as member
                </button>
                <span className="text-subtle">·</span>
                <button type="button" className="text-accent hover:underline" onClick={() => setAll("none")}>
                  Clear
                </button>
              </div>
            )}
          </div>

          {role === "admin" ? (
            <div className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-3 text-sm text-ink flex items-center gap-2">
              <Crown size={16} className="text-accent" /> Full access to all {boards.length} boards and workspace settings.
            </div>
          ) : boards.length === 0 ? (
            <div className="rounded-lg border border-dashed border-rule px-3 py-6 text-center text-sm text-muted">
              No boards yet.
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              {boards.length > 6 && (
                <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-inset text-sm">
                  <Search size={13} className="text-subtle" />
                  <input
                    className="flex-1 bg-transparent outline-none text-ink placeholder:text-subtle"
                    placeholder="Filter boards…"
                    value={boardQ}
                    onChange={(e) => setBoardQ(e.target.value)}
                  />
                </div>
              )}
              <ul className="divide-y divide-line max-h-[40vh] overflow-y-auto">
                {shownBoards.map((b) => (
                  <li key={b.id} className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      {b.visibility === "private" ? (
                        <Lock size={13} className="text-subtle shrink-0" />
                      ) : (
                        <Globe2 size={13} className="text-subtle shrink-0" />
                      )}
                      <span className={cn("truncate text-sm", access[b.id] === "none" ? "text-muted" : "text-ink font-medium")}>
                        {b.title}
                      </span>
                    </div>
                    <Segmented<Access>
                      value={access[b.id] ?? "none"}
                      onChange={(v) => setAccess((a) => ({ ...a, [b.id]: v }))}
                      options={[
                        { value: "none", label: "None" },
                        { value: "observer", label: "Observer" },
                        { value: "normal", label: "Member" },
                        { value: "admin", label: "Admin" },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <FieldError>{err}</FieldError>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
