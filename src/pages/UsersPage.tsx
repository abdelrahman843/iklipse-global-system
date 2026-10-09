import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Wand2,
  Crown,
  Globe2,
  Inbox,
  Kanban,
  Lock,
  Mail,
  MessageCircle,
  Minus,
  Plus,
  Search,
  Send,
  Shapes,
  ShieldCheck,
  ShieldOff,
  UserCog,
  UserRound,
  UserRoundX,
  KeyRound,
  LogOut,
  Sparkles,
  Trash2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AiModel, Board, BoardRole, MemberPolicy, ProductRoleValue, Profile, Role, WbRole, Workspace } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError, Hint } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { AI_GRADIENT } from "@/components/ui/Ai";
import { AI_MODELS, ai, setAiKey, useAiStatus } from "@/lib/ai";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { adminApi } from "@/lib/adminApi";
import { useAuth, WORKSPACE_ID } from "@/lib/auth";
import { useUsersRealtime } from "@/lib/pm/useBoardRealtime";
import { cn } from "@/lib/cn";
import { BOARD_ROLES, PRODUCT_ROLE_OPTIONS, ROLE_MATRIX, WB_ROLES, WB_ROLE_MATRIX, WORKSPACE_ROLES, productRole, wbRoleLabel, workspaceRoleLabel } from "@/lib/permissions";
import {
  EMAIL_RE,
  EMAIL_TAKEN,
  SEND_LIMIT_PER_HOUR,
  WHATSAPP_RE,
  emailInUse,
  fetchContact,
  fetchIntegrationStatus,
  inboxTargets,
  normalizeWhatsapp,
  saveContact,
  setEmailInbox,
  setGreenApi,
  testEmail,
  testWhatsapp,
  type IntegrationStatus,
} from "@/lib/integrationsApi";

// ============================================================================
// Users — Trello-style: each person gets ONE workspace role, then a role per
// board. What they can do comes from those roles (see the Roles tab), not
// from a pile of per-user checkboxes.
// ============================================================================

interface Row extends Profile {
  /** Board role per board; whiteboards carry their Miro role instead (0039). */
  boards: Record<string, BoardRole | WbRole>;
}

interface UsersData {
  rows: Row[];
  boards: Pick<Board, "id" | "title" | "visibility" | "kind">[];
}

async function fetchUsers(): Promise<UsersData> {
  const [profiles, members, boards] = await Promise.all([
    supabase.from("profile").select("*").order("created_at", { ascending: false }),
    supabase.from("board_member").select("board_id, user_id, role, wb_role"),
    supabase.from("board").select("id, title, visibility, kind").eq("is_archived", false).order("title"),
  ]);
  if (profiles.error) throw profiles.error;
  if (members.error) throw members.error;
  if (boards.error) throw boards.error;
  const byUser = new Map<string, Record<string, BoardRole | WbRole>>();
  for (const m of (members.data ?? []) as { board_id: string; user_id: string; role: BoardRole; wb_role: WbRole | null }[]) {
    const rec = byUser.get(m.user_id) ?? {};
    rec[m.board_id] = m.wb_role ?? m.role;
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

type Tab = "members" | "roles" | "integrations";

export function UsersPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
  const toast = useToast();
  const confirm = useConfirm();
  useUsersRealtime(true);

  const [tab, setTab] = useState<Tab>("members");
  const [signingOut, setSigningOut] = useState(false);
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

  // Shared by the wide table and the stacked mobile list.
  const emptyRows = (
    <EmptyState
      title={query || roleFilter !== "all" ? "No one matches." : "No members yet"}
      description={query || roleFilter !== "all" ? undefined : "Add your first employee to get started."}
    />
  );
  const boardsCell = (r: Row) => {
    const boardCount = Object.keys(r.boards).length;
    const t = productRole(r, "kanban");
    const m = productRole(r, "whiteboard");
    if (t === "admin" && m === "admin") return <span className="text-xs">Admin on all boards</span>;
    if (boardCount) return <BoardChips boards={data?.boards ?? []} roles={r.boards} />;
    return (
      <span className="text-xs text-subtle">
        {r.role === "guest" ? "No boards, can't see anything yet" : "No boards yet"}
      </span>
    );
  };
  // Trello / Miro roles under the workspace role, when they differ from it.
  const productLine = (r: Row) => {
    if (!r.trello_role && !r.miro_role) return null;
    const label = (x: Role | null) => (x ? workspaceRoleLabel(x) : "No access");
    return (
      <div className="mt-1 text-[11px] text-subtle whitespace-nowrap">
        Trello: {label(productRole(r, "kanban"))} · Miro: {label(productRole(r, "whiteboard"))}
      </div>
    );
  };
  const actionsCell = (r: Row) => (
    <div className="flex items-center justify-end gap-1.5">
      <Button size="sm" variant="ghost" iconLeft={<UserCog size={14} />} onClick={() => setEditing(r)} className="max-sm:h-10">
        Edit
      </Button>
      <Button
        size="sm"
        variant={r.is_active ? "subtle" : "primary"}
        iconLeft={r.is_active ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
        loading={toggleActive.isPending && toggleActive.variables?.id === r.id}
        className="max-sm:h-10"
        onClick={async () => {
          if (r.is_active) {
            const ok = await confirm({
              title: `Deactivate ${r.display_name}?`,
              message: "They will not be able to sign in.",
              confirmLabel: "Deactivate",
              danger: true,
            });
            if (!ok) return;
          }
          toggleActive.mutate(r);
        }}
      >
        {r.is_active ? "Deactivate" : "Reactivate"}
      </Button>
    </div>
  );

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
            variant="secondary"
            size="sm"
            iconLeft={<LogOut size={16} />}
            aria-label="Sign everyone out"
            title="Sign everyone out on every device"
            loading={signingOut}
            onClick={async () => {
              const ok = await confirm({
                title: "Sign everyone out?",
                message:
                  "Every person, including you, is signed out on every device right away and has to sign in again with their username and password.",
                confirmLabel: "Sign everyone out",
                danger: true,
              });
              if (!ok) return;
              setSigningOut(true);
              const { error } = await supabase.rpc("admin_sign_out", { p_user: null });
              setSigningOut(false);
              if (error) toast.push({ kind: "error", title: "Couldn't sign people out", description: error.message });
            }}
            className="shrink-0 max-sm:h-10"
          >
            <span className="hidden sm:inline">Sign everyone out</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus size={16} />}
            onClick={() => setCreating(true)}
            className="shrink-0 max-sm:h-10"
          >
            <span className="hidden sm:inline">Add member</span>
            <span className="sm:hidden">Add</span>
          </Button>
        </div>

        <div className="border-b border-border flex gap-1 mb-5">
          {/* Short labels on phones so the three tabs fit a 320px screen. */}
          {(
            [
              ["members", "Members", "Members"],
              ["roles", "Roles & settings", "Roles"],
              ["integrations", "Integrations", "Integrations"],
            ] as [Tab, string, string][]
          ).map(([t, label, short]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "relative h-10 sm:h-9 px-3 text-sm font-medium whitespace-nowrap transition-colors",
                tab === t ? "text-ink" : "text-muted hover:text-ink",
              )}
            >
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{short}</span>
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
        ) : tab === "integrations" ? (
          <div key="integrations" className="view-enter">
            <IntegrationsTab />
          </div>
        ) : (
          <div key="members" className="view-enter">
            <div className="mb-4 flex flex-col sm:flex-row gap-2 sm:items-center">
              <div className="flex-1 min-w-0 sm:max-w-sm flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 h-10 sm:h-9 text-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
                <Search size={14} className="text-subtle shrink-0" />
                {/* 16px on phones so iOS doesn't zoom in on focus. */}
                <input
                  className="flex-1 min-w-0 bg-transparent outline-none text-ink placeholder:text-subtle text-lg sm:text-sm"
                  placeholder="Search by name or username…"
                  aria-label="Search members"
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

            {/* Phones and narrow tablets: stacked rows instead of a wide table. */}
            <ul className="lg:hidden rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
              {rows.length === 0 && <li>{emptyRows}</li>}
              {rows.map((r, i) => (
                <li
                  key={r.id}
                  style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                  className={cn("rise px-3 py-3 space-y-2", !r.is_active && "opacity-60")}
                >
                  <div className="flex items-center gap-2.5">
                    <Avatar name={r.display_name} src={r.avatar_url} size={30} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-ink truncate">{r.display_name}</div>
                      <div className="text-xs text-subtle truncate">@{r.username}</div>
                    </div>
                    {r.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Deactivated</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                    <RoleBadge role={r.role} />
                          {productLine(r)}
                    {boardsCell(r)}
                  </div>
                  {actionsCell(r)}
                </li>
              ))}
            </ul>

            <div className="hidden lg:block rounded-lg border border-border bg-surface shadow-card overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-inset text-muted text-[11px] uppercase tracking-eyebrow border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Member</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Workspace role</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Trello & Miro</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5}>{emptyRows}</td>
                    </tr>
                  )}
                  {rows.map((r, i) => {
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
                          {productLine(r)}
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {boardsCell(r)}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Deactivated</Badge>}
                        </td>
                        <td className="px-4 py-2.5">
                          {actionsCell(r)}
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

function BoardChips({ boards, roles }: { boards: UsersData["boards"]; roles: Record<string, BoardRole | WbRole> }) {
  const list = boards.filter((b) => roles[b.id]);
  const shown = list.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((b) => (
        <span
          key={b.id}
          className="inline-flex items-center gap-1 max-w-[160px] rounded-full border border-line bg-inset px-2 py-0.5 text-xs font-medium text-muted"
          title={`${b.title} (${b.kind === "whiteboard" ? "Miro" : "Trello"}): ${accessLabel(roles[b.id]!)}`}
        >
          {b.kind === "whiteboard" ? (
            <Shapes size={11} className="text-subtle shrink-0" aria-label="Miro" />
          ) : (
            <Kanban size={11} className="text-subtle shrink-0" aria-label="Trello" />
          )}
          <span className="truncate">{b.title}</span>
          {roles[b.id] !== "normal" && roles[b.id] !== "editor" && (
            <span className="text-subtle shrink-0">· {accessLabel(roles[b.id]!)}</span>
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
      hint: "Trello and Miro boards. Guests can never create boards.",
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
        <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <Kanban size={15} className="text-subtle" /> Trello roles
        </h2>
        <p className="text-sm text-muted mb-3">
          Given per Trello board, in the board's Share dialog or here when editing a user.
        </p>
        <div className="rounded-lg border border-border bg-surface shadow-card overflow-x-auto">
          {/* Tighter cells on phones so the matrix fits without sideways scroll. */}
          <table className="w-full text-sm sm:min-w-[560px]">
            <thead className="bg-inset text-muted text-[11px] uppercase tracking-eyebrow border-b border-border">
              <tr>
                <th className="text-left px-2.5 sm:px-4 py-2.5 font-semibold">Can…</th>
                {BOARD_ROLES.map((r) => (
                  <th key={r.value} className="px-1.5 sm:px-4 py-2.5 font-semibold text-center w-[18%]">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLE_MATRIX.map((row) => (
                <tr key={row.label} className="border-t border-line">
                  <td className="px-2.5 sm:px-4 py-2 text-ink">{row.label}</td>
                  {(["admin", "normal", "observer"] as const).map((k) => (
                    <td key={k} className="px-1.5 sm:px-4 py-2 text-center">
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
        <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <Shapes size={15} className="text-subtle" /> Miro roles
        </h2>
        <p className="text-sm text-muted mb-3">
          Given per Miro board, in the board's Share dialog or here when editing a user. Each board also sets what
          everyone in the workspace gets without an invite (no access, view, comment or edit); people get the higher of
          the two.
        </p>
        <div className="rounded-lg border border-border bg-surface shadow-card overflow-x-auto">
          <table className="w-full text-sm sm:min-w-[640px]">
            <thead className="bg-inset text-muted text-[11px] uppercase tracking-eyebrow border-b border-border">
              <tr>
                <th className="text-left px-2.5 sm:px-4 py-2.5 font-semibold">Can…</th>
                {WB_ROLES.map((r) => (
                  <th key={r.value} className="px-1.5 sm:px-3 py-2.5 font-semibold text-center w-[13%]">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WB_ROLE_MATRIX.map((row) => (
                <tr key={row.label} className="border-t border-line">
                  <td className="px-2.5 sm:px-4 py-2 text-ink">{row.label}</td>
                  {(["owner", "coowner", "editor", "commenter", "viewer"] as const).map((k) => (
                    <td key={k} className="px-1.5 sm:px-3 py-2 text-center">
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
  const confirm = useConfirm();
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
        Build cards from a brief, data and files, and ask the AI to comment, rewrite or plan inside a card. People only
        get AI on boards they can edit, output is always English, and every result is a suggestion they have to accept.
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
                className="pr-9 max-sm:h-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center h-7 w-7 rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={saveKey.isPending}
              disabled={!key.trim()}
              className="max-sm:h-10 shrink-0"
            >
              Save
            </Button>
            {s?.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove key"
                title="Remove key"
                className="max-sm:h-10 max-sm:w-10 shrink-0"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove the OpenAI key?",
                    message: "AI stops working until a new key is added.",
                    confirmLabel: "Remove key",
                    danger: true,
                  });
                  if (ok) saveKey.mutate(null);
                }}
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
          <Select
            className="w-full sm:w-64"
            aria-label="AI model"
            value={workspace?.ai_model ?? "gpt-4o-mini"}
            disabled={!workspace || save.isPending}
            onChange={(v) => save.mutate({ ai_model: v as AiModel })}
            options={AI_MODELS.map((m) => ({ value: m.value, label: m.label }))}
          />
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
// Integrations tab: WhatsApp (Green API), email (Gmail through n8n) and email
// to card. Like the OpenAI key, the secrets are write-only (Vault).
// ============================================================================

function IntegrationsTab() {
  const status = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrationStatus });
  if (status.isLoading) return <PageSpinner />;
  if (!status.data)
    return <EmptyState title="Couldn't load integrations" description={(status.error as Error | null)?.message} />;
  return (
    <div className="space-y-8">
      <WhatsAppSettings s={status.data} />
      <EmailSettings s={status.data} />
      <EmailInboxSettings s={status.data} />
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
      <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">{icon}</span>
      {children}
    </h2>
  );
}

function WhatsAppSettings({ s }: { s: IntegrationStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const wa = s.whatsapp;
  const [url, setUrl] = useState(wa.url ?? "");
  const [instance, setInstance] = useState(wa.instance ?? "");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const ready = !!(url.trim() && instance.trim() && token.trim());

  // All three empty = remove (see admin_set_greenapi).
  const save = useMutation({
    mutationFn: (v: { url: string; instance: string; token: string }) => setGreenApi(v.url, v.instance, v.token),
    onSuccess: async (_d, v) => {
      setToken("");
      if (!v.token) {
        setUrl("");
        setInstance("");
      }
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        v.token
          ? { kind: "success", title: "WhatsApp saved", description: "Send a test to check it works." }
          : { kind: "success", title: "WhatsApp removed" },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save WhatsApp", description: e.message }),
  });

  const test = useMutation({
    mutationFn: testWhatsapp,
    onSuccess: (sent) => {
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        sent
          ? { kind: "success", title: "Test sent", description: "Check WhatsApp on your phone." }
          : { kind: "error", title: "Test not sent", description: "WhatsApp isn't connected, or the hourly limit was reached." },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Test failed", description: e.message }),
  });

  return (
    <section>
      <SectionTitle icon={<MessageCircle size={12} />}>WhatsApp (Green API)</SectionTitle>
      <p className="text-sm text-muted mb-3">
        Sends notifications to members who turn it on, and the WhatsApp messages from automation rules. Each person's
        number goes on their member card.
      </p>
      <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line">
        <div className="px-4 py-3">
          <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
            <KeyRound size={14} /> Connection
            {wa.configured ? (
              <Badge tone="success">Connected, instance {wa.instance}</Badge>
            ) : (
              <Badge tone="warn">Not connected</Badge>
            )}
          </div>
          <div className="text-xs text-muted">
            In the Green API console open your instance: copy apiUrl, idInstance and apiTokenInstance. The phone linked
            to the instance sends the messages.
          </div>
        </div>

        <form
          className="px-4 py-3 grid gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate({ url: url.trim(), instance: instance.trim(), token: token.trim() });
          }}
        >
          <div>
            <Label htmlFor="ga-url">API URL</Label>
            <Input
              id="ga-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://7103.api.greenapi.com"
              autoComplete="off"
              spellCheck={false}
              className="max-sm:h-10"
            />
          </div>
          <div>
            <Label htmlFor="ga-id">
              Instance ID <span className="font-normal text-subtle">idInstance</span>
            </Label>
            <Input
              id="ga-id"
              inputMode="numeric"
              value={instance}
              onChange={(e) => setInstance(e.target.value.replace(/\s/g, ""))}
              placeholder="7103123456"
              autoComplete="off"
              spellCheck={false}
              className="max-sm:h-10"
            />
          </div>
          <div>
            <Label htmlFor="ga-token">
              API token <span className="font-normal text-subtle">apiTokenInstance</span>
            </Label>
            <div className="relative">
              <Input
                id="ga-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={wa.configured ? "Saved. Paste it again to change" : "Paste the token"}
                autoComplete="off"
                spellCheck={false}
                className="pr-9 max-sm:h-10"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center h-7 w-7 rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <div className="md:col-span-3 flex items-center justify-end gap-2">
            {wa.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                iconLeft={<Trash2 size={14} />}
                disabled={save.isPending}
                className="max-sm:h-10"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove the WhatsApp connection?",
                    message: "No WhatsApp messages are sent until it's connected again.",
                    confirmLabel: "Remove",
                    danger: true,
                  });
                  if (ok) save.mutate({ url: "", instance: "", token: "" });
                }}
              >
                Remove
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={save.isPending}
              disabled={!ready}
              className="max-sm:h-10"
            >
              Save
            </Button>
          </div>
        </form>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
          <div className="flex-1 min-w-0 text-xs text-muted">
            Messages sent in the last hour: <span className="text-ink font-medium">{s.sent_last_hour}</span> (limit{" "}
            {SEND_LIMIT_PER_HOUR})
          </div>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Send size={14} />}
            loading={test.isPending}
            disabled={!wa.configured}
            onClick={() => test.mutate()}
            className="max-sm:h-10"
          >
            Send a test to my WhatsApp
          </Button>
        </div>
      </div>
    </section>
  );
}

function EmailSettings({ s }: { s: IntegrationStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const on = s.email.configured;

  const test = useMutation({
    mutationFn: testEmail,
    onSuccess: (sent) => {
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push(
        sent
          ? { kind: "success", title: "Test sent", description: "Check your inbox." }
          : { kind: "error", title: "Test not sent", description: "Email isn't connected, or the hourly limit was reached." },
      );
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Test failed", description: e.message }),
  });

  return (
    <section>
      <SectionTitle icon={<Mail size={12} />}>Email (Gmail)</SectionTitle>
      <p className="text-sm text-muted mb-3">
        Sends notifications to members who turn it on, and the emails from automation rules. Each person's address goes
        on their member card.
      </p>
      <div className="rounded-lg border border-border bg-surface shadow-card">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
              <KeyRound size={14} /> Connection
              {on ? <Badge tone="success">Connected</Badge> : <Badge tone="warn">Not connected yet</Badge>}
            </div>
            <div className="text-xs text-muted">
              {on
                ? `Connected through n8n. Shares the limit of ${SEND_LIMIT_PER_HOUR} messages an hour with WhatsApp.`
                : "Connected through n8n. Finish the Gmail setup in n8n and this turns on."}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Send size={14} />}
            loading={test.isPending}
            disabled={!on}
            onClick={() => test.mutate()}
            className="max-sm:h-10"
          >
            Send a test to my email
          </Button>
        </div>
      </div>
    </section>
  );
}

function EmailInboxSettings({ s }: { s: IntegrationStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const targets = useQuery({ queryKey: ["inbox-targets"], queryFn: inboxTargets });

  const save = useMutation({
    mutationFn: (listId: string | null) => setEmailInbox(listId),
    onSuccess: async (_d, listId) => {
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.push({ kind: "success", title: listId ? "Email to card is on" : "Email to card is off" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  const current = s.inbox.list_id ?? "";
  const options = [{ value: "", label: "Off" }, ...(targets.data ?? [])];
  // A list the picker doesn't offer (its board was archived): still show it.
  if (current && !options.some((o) => o.value === current))
    options.push({ value: current, label: `${s.inbox.board_title ?? "Board"} / ${s.inbox.list_title ?? "List"}` });

  return (
    <section>
      <SectionTitle icon={<Inbox size={12} />}>Email to card</SectionTitle>
      <p className="text-sm text-muted mb-3">
        Team members can email the system's Gmail address from the email saved on their member card. Each email becomes
        a card: the subject is the title and the text is the description.
      </p>
      <div className="rounded-lg border border-border bg-surface shadow-card">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2">
              List for new cards
              {current ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
            </div>
            <div className="text-xs text-muted">Only senders who can edit that board get a card.</div>
          </div>
          <Select
            className="w-full sm:w-72"
            aria-label="List for emailed cards"
            value={save.isPending ? (save.variables ?? "") : current}
            disabled={save.isPending || targets.isLoading}
            onChange={(v) => save.mutate(v || null)}
            options={options}
          />
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Create / edit modal
// ============================================================================

type Access = BoardRole | WbRole | "none";

const WB_TO_BOARD: Record<WbRole, BoardRole> = { owner: "admin", coowner: "admin", editor: "normal", commenter: "observer", viewer: "observer" };
const BOARD_TO_WB: Record<BoardRole, WbRole> = { admin: "coowner", normal: "editor", observer: "viewer" };
const isWbRole = (a: Access): a is WbRole => ["owner", "coowner", "editor", "commenter", "viewer"].includes(a);
function accessLabel(a: BoardRole | WbRole) {
  return isWbRole(a) ? wbRoleLabel(a) : (BOARD_ROLES.find((r) => r.value === a)?.label ?? a);
}

// Same rule as the admin-create/update-member edge functions.
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;

// People sign in with the username only (no email anywhere).
const stripSpaces = (v: string) => v.replace(/\s/g, "");

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
        "shrink-0 h-full w-10 sm:w-8 grid place-items-center border-l border-line text-muted hover:text-ink hover:bg-inset transition-colors",
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
  // Trello / Miro roles: "same" follows the workspace role (0044).
  const [trelloRole, setTrelloRole] = useState<ProductRoleValue | "same">(member?.trello_role ?? "same");
  const [miroRole, setMiroRole] = useState<ProductRoleValue | "same">(member?.miro_role ?? "same");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [access, setAccess] = useState<Record<string, Access>>(() =>
    Object.fromEntries(boards.map((b) => [b.id, member?.boards[b.id] ?? "none"])),
  );
  const [boardQ, setBoardQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const self = member?.id === user?.id;

  // WhatsApp / email for notifications (profile_contact), saved after the member.
  const [whatsapp, setWhatsapp] = useState("");
  const [email, setEmail] = useState("");
  const [notifyWa, setNotifyWa] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [checked, setChecked] = useState({ wa: false, em: false });
  const [emailTaken, setEmailTaken] = useState(false);
  const contact = useQuery({
    queryKey: ["profile-contact", member?.id],
    queryFn: () => fetchContact(member!.id),
    enabled: mode === "edit" && !!member,
    gcTime: 0, // fresh every time the modal opens
  });
  // Edit: fields stay locked until the saved values are in, so a save can't wipe them.
  const [contactReady, setContactReady] = useState(mode === "create");
  useEffect(() => {
    if (contactReady || !contact.isSuccess) return;
    setWhatsapp(contact.data?.whatsapp ?? "");
    setEmail(contact.data?.email ?? "");
    setNotifyWa(contact.data?.notify_whatsapp ?? false);
    setNotifyEmail(contact.data?.notify_email ?? false);
    setContactReady(true);
  }, [contactReady, contact.isSuccess, contact.data]);
  const waValue = whatsapp.trim() ? normalizeWhatsapp(whatsapp) : "";
  const emailValue = email.trim();
  const waBad = checked.wa && !!waValue && !WHATSAPP_RE.test(waValue);
  const emailBad = checked.em && !!emailValue && !EMAIL_RE.test(emailValue);

  const shownBoards = boards.filter((b) => b.title.toLowerCase().includes(boardQ.trim().toLowerCase()));
  const onCount = Object.values(access).filter((a) => a !== "none").length;

  async function syncBoards(userId: string) {
    const before = member?.boards ?? {};
    const errors: string[] = [];
    for (const b of boards) {
      const want = access[b.id] ?? "none";
      const had = before[b.id];
      let res: { error: { message: string } | null } | null = null;
      // Whiteboards store the Miro role; the board role follows it (0039).
      const row =
        want === "none" ? null : isWbRole(want) ? { role: WB_TO_BOARD[want], wb_role: want } : { role: want };
      if (want === "none" && had) {
        res = await supabase.from("board_member").delete().eq("board_id", b.id).eq("user_id", userId);
      } else if (row && !had) {
        // upsert: a Trello-linked account may already have been put on the board
        res = await supabase.from("board_member").upsert({ board_id: b.id, user_id: userId, ...row }, { onConflict: "board_id,user_id" });
      } else if (row && had && want !== had) {
        res = await supabase.from("board_member").update(row).eq("board_id", b.id).eq("user_id", userId);
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
          ? `Username can't be an email. Try "${suggestUsername(username)}". People sign in with the username, not an email.`
          : "Username must be 3-32 characters: letters, digits, dot, dash or underscore.",
      );
    if (mode === "create" && password.length < 8) return setErr("Password must be at least 8 characters.");
    if ((waValue && !WHATSAPP_RE.test(waValue)) || (emailValue && !EMAIL_RE.test(emailValue))) {
      setChecked({ wa: true, em: true });
      return setErr("Check the WhatsApp number and email.");
    }
    setBusy(true);
    try {
      // Caught here so a new member isn't created with half their details.
      if (emailValue && contactReady && (await emailInUse(emailValue, member?.id).catch(() => false))) {
        setEmailTaken(true);
        return setErr(EMAIL_TAKEN);
      }
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
      // Trello / Miro roles (admins can set them, never on themselves).
      let boardErr: string | null = null;
      if (id && !self) {
        const { error } = await supabase
          .from("profile")
          .update({ trello_role: trelloRole === "same" ? null : trelloRole, miro_role: miroRole === "same" ? null : miroRole } as never)
          .eq("id", id);
        if (error) boardErr = `Trello / Miro roles: ${error.message}`;
      }
      // Admins of both products are admin on every board: their board rows don't matter.
      const allAdmin = (trelloRole === "same" ? role : trelloRole) === "admin" && (miroRole === "same" ? role : miroRole) === "admin";
      if (id && !allAdmin) {
        try {
          await syncBoards(id);
        } catch (e) {
          boardErr = [boardErr, e instanceof Error ? e.message : "Board access failed"].filter(Boolean).join(" ");
        }
      }
      // Empty fields are saved as null; nothing to save for a new member with no contact.
      let contactErr: string | null = null;
      if (id && contactReady && (contact.data || waValue || emailValue)) {
        try {
          await saveContact({
            user_id: id,
            whatsapp: waValue || null,
            email: emailValue || null,
            notify_whatsapp: notifyWa && !!waValue,
            notify_email: notifyEmail && !!emailValue,
          });
        } catch (e) {
          contactErr = (e as { message?: string })?.message ?? "Save failed.";
        }
      }
      const problems = [
        boardErr && `Some board access wasn't saved: ${boardErr}`,
        contactErr && `Notification settings weren't saved: ${contactErr}`,
      ]
        .filter(Boolean)
        .join(" ");
      toast.push(
        problems
          ? { kind: "info", title: mode === "create" ? "Member created" : "Member updated", description: problems }
          : { kind: "success", title: mode === "create" ? "Member created" : "Member updated" },
      );
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const [confirmDelete, setConfirmDelete] = useState(false);
  async function removeMember() {
    if (!member) return;
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.rpc("admin_delete_member" as never, { p_user: member.id } as never);
      if (error) throw error;
      toast.push({ kind: "success", title: "User deleted", description: `@${member.username} can no longer sign in.` });
      onSaved();
    } catch (e: unknown) {
      setConfirmDelete(false);
      setErr((e as { message?: string })?.message ?? "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  // The owner of a whiteboard keeps it; "member" on a whiteboard means editor.
  const setAll = (a: BoardRole | "none") =>
    setAccess((cur) =>
      Object.fromEntries(
        boards.map((b) => [b.id, cur[b.id] === "owner" ? "owner" : b.kind === "whiteboard" && a !== "none" ? BOARD_TO_WB[a] : a]),
      ),
    );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      fitViewport
      title={mode === "create" ? "Add member" : `Edit ${member?.display_name}`}
      footer={
        confirmDelete && member ? (
          // Phones: the warning takes its own line above the buttons.
          <div className="w-full flex flex-wrap items-center justify-end gap-2">
            <span className="w-full sm:w-auto sm:flex-1 min-w-0 break-words text-sm text-ink">
              Delete <b>@{member.username}</b> for good? Their comments, cards and history stay and move to the admin
              account.
            </span>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Keep
            </Button>
            <Button variant="danger" iconLeft={<Trash2 size={14} />} onClick={removeMember} loading={busy}>
              Delete user
            </Button>
          </div>
        ) : (
          <>
            {mode === "edit" && member && !self && (
              <Button
                variant="ghost"
                iconLeft={<Trash2 size={14} />}
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete user"
                className="mr-auto !text-danger hover:!bg-danger/10"
              >
                {/* Icon only on phones so the three footer buttons fit one row. */}
                <span className="hidden sm:inline">Delete user</span>
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => submit()} loading={busy}>
              {mode === "create" ? "Create member" : "Save changes"}
            </Button>
          </>
        )
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
                "flex items-center h-10 sm:h-9 rounded-md border bg-surface text-sm transition-[border-color,box-shadow] duration-150 focus-within:ring-2 focus-within:ring-accent-ring",
                username && !USERNAME_RE.test(username.trim())
                  ? "border-danger"
                  : "border-border focus-within:border-accent",
              )}
            >
              <input
                id="un"
                className="flex-1 min-w-0 h-full bg-transparent px-3 outline-none text-ink placeholder:text-subtle text-lg sm:text-sm"
                placeholder="shams"
                autoComplete="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(stripSpaces(e.target.value))}
                aria-invalid={!!username && !USERNAME_RE.test(username.trim())}
              />
            </div>
            {username.includes("@") ? (
              <Hint>
                Only the part before @:{" "}
                <button type="button" className="text-accent hover:underline" onClick={() => setUsername(suggestUsername(username))}>
                  use “{suggestUsername(username)}”
                </button>
              </Hint>
            ) : (
              <Hint>Signs in with the username {username.trim() || "username"} and the password.</Hint>
            )}
          </div>
          <div>
            <Label htmlFor="pw">{mode === "create" ? "Password" : "Reset password"}</Label>
            <div className="flex items-center h-10 sm:h-9 rounded-md border border-border bg-surface text-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
              <input
                id="pw"
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                className="flex-1 min-w-0 h-full bg-transparent px-3 outline-none text-ink placeholder:text-subtle font-mono text-lg sm:text-sm"
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
          <Label>Trello and Miro</Label>
          <div className="grid gap-3">
            {(
              [
                ["Trello", trelloRole, setTrelloRole],
                ["Miro", miroRole, setMiroRole],
              ] as const
            ).map(([name, value, setValue]) => (
              <div key={name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="w-14 text-sm font-medium text-ink">{name}</span>
                <Segmented<ProductRoleValue | "same">
                  value={value}
                  onChange={setValue}
                  disabled={self}
                  options={PRODUCT_ROLE_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.value === "same" ? `Same (${workspaceRoleLabel(role)})` : o.label,
                  }))}
                />
              </div>
            ))}
          </div>
          <Hint>Someone can be an admin in Trello and a member in Miro, or have no access to one of them. "Same" follows the workspace role.</Hint>
        </section>

        <section>
          <div className="mb-2">
            <div className="text-sm font-medium text-ink">Notifications</div>
            <div className="text-xs text-muted">
              {contact.isError
                ? "Couldn't load their saved number and email. Close and open again to retry."
                : "Their in-app notifications can also go to WhatsApp and email."}
            </div>
          </div>
          <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="wa">WhatsApp number</Label>
              <Input
                id="wa"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="201001234567"
                value={whatsapp}
                disabled={!contactReady}
                onChange={(e) => setWhatsapp(e.target.value)}
                // Show what will be saved: 01001234567 becomes 201001234567.
                onBlur={() => {
                  setWhatsapp((v) => (v.trim() ? normalizeWhatsapp(v) : ""));
                  setChecked((c) => ({ ...c, wa: true }));
                }}
                aria-invalid={waBad}
                className={cn("max-sm:h-10", waBad && "border-danger")}
              />
              {waBad ? (
                <FieldError>Use digits only, country code first. Example: 201001234567</FieldError>
              ) : (
                <Hint>Country code first, no +. Example: 201001234567</Hint>
              )}
              <div className="mt-2">
                <Toggle
                  checked={notifyWa && !!waValue}
                  disabled={!contactReady || !waValue}
                  onChange={setNotifyWa}
                  label="Send their notifications to WhatsApp"
                  hint={waValue ? undefined : "Add a number first."}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="em">Email for notifications</Label>
              <Input
                id="em"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="name@example.com"
                value={email}
                disabled={!contactReady}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailTaken(false);
                }}
                onBlur={() => setChecked((c) => ({ ...c, em: true }))}
                aria-invalid={emailBad || emailTaken}
                className={cn("max-sm:h-10", (emailBad || emailTaken) && "border-danger")}
              />
              {emailTaken ? (
                <FieldError>{EMAIL_TAKEN}</FieldError>
              ) : emailBad ? (
                <FieldError>Enter a full email address, like name@example.com</FieldError>
              ) : (
                <Hint>Only for notifications and email-to-card. Sign-in stays username + password.</Hint>
              )}
              <div className="mt-2">
                <Toggle
                  checked={notifyEmail && !!emailValue}
                  disabled={!contactReady || !emailValue}
                  onChange={setNotifyEmail}
                  label="Send their notifications to email"
                  hint={emailValue ? undefined : "Add an email first."}
                />
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">Board access</div>
              <div className="text-xs text-muted">
                {role === "admin"
                  ? "Workspace admins are admin on every board automatically."
                  : `${onCount} of ${boards.length} boards${role === "member" ? " · members also see workspace-visible boards and can join them" : ""}`}
              </div>
            </div>
            {role !== "admin" && boards.length > 1 && (
              <div className="ml-auto flex gap-1 text-xs">
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
            <div className="rounded-lg border border-accent/25 bg-accent-soft px-3 py-3 text-sm text-ink flex items-center gap-2">
              <Crown size={16} className="text-accent" /> Full access to all {boards.length} boards and workspace settings.
            </div>
          ) : boards.length === 0 ? (
            <div className="rounded-lg border border-dashed border-rule px-3 py-6 text-center text-sm text-muted">
              No boards yet.
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              {boards.length > 6 && (
                <div className="flex items-center gap-2 px-3 h-10 sm:h-9 border-b border-line bg-inset text-sm">
                  <Search size={13} className="text-subtle shrink-0" />
                  <input
                    className="flex-1 min-w-0 bg-transparent outline-none text-ink placeholder:text-subtle text-lg sm:text-sm"
                    placeholder="Filter boards…"
                    aria-label="Filter boards"
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
                      <span className="inline-flex items-center gap-1 text-[11px] text-subtle shrink-0">
                        {b.kind === "whiteboard" ? <Shapes size={12} /> : <Kanban size={12} />}
                        <span className="hidden sm:inline">{b.kind === "whiteboard" ? "Miro" : "Trello"}</span>
                      </span>
                    </div>
                    {access[b.id] === "owner" ? (
                      <span className="text-sm text-ink px-2" title="Change the owner from the board's Share dialog">
                        Owner
                      </span>
                    ) : b.kind === "whiteboard" ? (
                      <Segmented<Access>
                        value={access[b.id] ?? "none"}
                        onChange={(v) => setAccess((a) => ({ ...a, [b.id]: v }))}
                        options={[
                          { value: "none", label: "None" },
                          { value: "viewer", label: "Viewer" },
                          { value: "commenter", label: "Commenter" },
                          { value: "editor", label: "Editor" },
                          { value: "coowner", label: "Co-owner" },
                        ]}
                      />
                    ) : (
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
                    )}
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
