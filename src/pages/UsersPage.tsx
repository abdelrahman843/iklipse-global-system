import { useEffect, useMemo, useState } from "react";
import { SearchField } from "@/components/ui/SearchField";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Wand2,
  Crown,
  Globe2,
  Kanban,
  Lock,
  Plus,
  Search,
  Shapes,
  ShieldCheck,
  ShieldOff,
  UserCog,
  UserRound,
  UserRoundX,
  LogOut,
  Trash2,
  X,
} from "lucide-react";
import { fetchMemberPhones, linkNumber } from "@/lib/watchApi";
import { supabase } from "@/lib/supabase";
import type { Board, BoardRole, ProductRoleValue, Profile, Role, WbRole } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { Pager, usePaged } from "@/components/ui/Pager";
import { Input, Label, FieldError, Hint } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { adminApi } from "@/lib/adminApi";
import { useAuth } from "@/lib/auth";
import { useUsersRealtime } from "@/lib/pm/useBoardRealtime";
import { cn } from "@/lib/cn";
import { BOARD_ROLES, PRODUCT_ROLE_OPTIONS, WORKSPACE_ROLES, productRole, wbRoleLabel, workspaceRoleLabel } from "@/lib/permissions";
import { PageTitle, plural } from "@/components/ui/PageTitle";
import { LineTabs } from "@/components/ui/LineTabs";
import { TeamContactsNote } from "@/components/users/TeamContacts";
import { AttendanceTab } from "@/components/users/AttendanceTab";
import {
  EMAIL_RE,
  EMAIL_TAKEN,
  WHATSAPP_RE,
  emailInUse,
  fetchContact,
  normalizeWhatsapp,
  saveContact,
} from "@/lib/integrationsApi";

// ============================================================================
// Users — Trello-style: each person gets ONE workspace role, then a role per
// board. What they can do comes from those roles, not from a pile of
// per-user checkboxes.
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

type Tab = "members" | "attendance";
const TABS: Tab[] = ["members", "attendance"];

export function UsersPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
  const toast = useToast();
  const confirm = useConfirm();
  useUsersRealtime(true);

  // ?tab= picks the tab (the old Attendance page lands on its tab).
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : "members";
  const setTab = (t: Tab) => setParams(t === "members" ? {} : { tab: t }, { replace: true });
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
  const paged = usePaged(rows, "users");

  const counts = useMemo(() => {
    const c: Record<Role, number> = { admin: 0, member: 0, guest: 0 };
    for (const r of data?.rows ?? []) c[r.role]++;
    return c;
  }, [data]);

  const toggleActive = useMutation({
    mutationFn: (r: Row) => adminApi.updateMember({ user_id: r.id, is_active: !r.is_active }),
    onSuccess: (_, r) => {
      toast.push({ kind: "success", title: r.is_active ? `${r.display_name} left the team` : `${r.display_name} is back on the team` });
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
              title: `Mark ${r.display_name} as left?`,
              message: "They can't sign in anymore. Their work stays in iklipse, and you can bring them back.",
              confirmLabel: "Mark as left",
              danger: true,
            });
            if (!ok) return;
          }
          toggleActive.mutate(r);
        }}
      >
        {r.is_active ? "Mark as left" : "Bring back"}
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
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <PageTitle count={data && plural(data.rows.length, "member")} info="Give each person a workspace role, then decide which boards they're on and as what.">Users</PageTitle>
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

        <LineTabs
          value={tab}
          onChange={setTab}
          label="Users"
          className="mb-5"
          tabs={[
            { value: "members", label: "Members" },
            { value: "attendance", label: "Attendance" },
          ]}
        />

        {tab === "attendance" ? (
          <div key="attendance" className="view-enter">
            <AttendanceTab />
          </div>
        ) : (
          <div key="members" className="view-enter">
            <TeamContactsNote />
            <div className="mb-4 flex flex-col sm:flex-row gap-2 sm:items-center">
              <SearchField
                className="flex-1 min-w-0 sm:max-w-sm"
                value={query}
                onChange={setQuery}
                hotkey
                placeholder="Search by name or username…"
                aria-label="Search members"
              />
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
            <ul className="lg:hidden divide-y divide-line border-y border-line">
              {rows.length === 0 && <li>{emptyRows}</li>}
              {paged.rows.map((r, i) => (
                <li
                  key={r.id}
                  style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                  className={cn("rise py-3 space-y-2", !r.is_active && "opacity-60")}
                >
                  <div className="flex items-center gap-2.5">
                    <Avatar name={r.display_name} src={r.avatar_url} size={30} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-ink truncate">{r.display_name}</div>
                      <div className="text-xs text-subtle truncate">@{r.username}</div>
                    </div>
                    {r.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Left</Badge>}
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

            <div className="hidden lg:block overflow-x-auto border-y border-line">
              <table className="w-full text-sm min-w-[720px] [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
                <thead className="text-muted text-sm border-b border-line">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium">Member</th>
                    <th className="text-left px-4 py-2.5 font-medium">Workspace role</th>
                    <th className="text-left px-4 py-2.5 font-medium">Trello & Miro</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    <th className="text-right px-4 py-2.5 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5}>{emptyRows}</td>
                    </tr>
                  )}
                  {paged.rows.map((r, i) => {
                    return (
                      <tr
                        key={r.id}
                        style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                        className={cn(
                          "rise border-t border-line align-middle hover:bg-inset/60 transition-colors",
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
                          {r.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Left</Badge>}
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
            <Pager {...paged.pager} />
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
// Create / edit modal
// ============================================================================

type Access = BoardRole | WbRole | "none";

const WB_TO_BOARD: Record<WbRole, BoardRole> = { owner: "admin", coowner: "admin", editor: "normal", commenter: "observer", viewer: "observer" };
const BOARD_TO_WB: Record<BoardRole, WbRole> = { admin: "coowner", normal: "editor", observer: "viewer" };
const isWbRole = (a: Access): a is WbRole => ["owner", "coowner", "editor", "commenter", "viewer"].includes(a);
/** Higher means more rights. */
const WS_RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2 };
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
  const confirm = useConfirm();
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState(member?.display_name ?? "");
  const [username, setUsername] = useState(member?.username ?? "");
  const [role, setRole] = useState<Role>(member?.role ?? "member");
  // Trello / Miro roles: "same" follows the workspace role (0044).
  const [trelloRole, setTrelloRole] = useState<ProductRoleValue | "same">(member?.trello_role ?? "same");
  const [miroRole, setMiroRole] = useState<ProductRoleValue | "same">(member?.miro_role ?? "same");
  // Deliveries (0062): prepare deliveries and send client links. Admins always can.
  const [deliveryRole, setDeliveryRole] = useState<"manage" | "none">(member?.delivery_role === "manage" ? "manage" : "none");
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

  // Admins of both products are admin on every board: their board rows don't matter.
  const allAdmin = (trelloRole === "same" ? role : trelloRole) === "admin" && (miroRole === "same" ? role : miroRole) === "admin";

  /** What saving an edit would take away from the person, for the confirm. */
  function losses(m: Row): string[] {
    const out: string[] = [];
    if (password) out.push(self ? "Reset your password" : "Reset their password. The old one stops working");
    // Self edits never save these (see submit).
    if (!self) {
      if (WS_RANK[role] < WS_RANK[m.role])
        out.push(`Lower their workspace role from ${workspaceRoleLabel(m.role)} to ${workspaceRoleLabel(role)}`);
      if (trelloRole === "none" && m.trello_role !== "none") out.push("Take away their Trello access");
      if (miroRole === "none" && m.miro_role !== "none") out.push("Take away their Miro access");
      // Admins can always use Deliveries, so losing admin can take it away too.
      if (role !== "admin" && deliveryRole === "none" && (m.delivery_role === "manage" || m.role === "admin"))
        out.push("Take away their Deliveries access");
    }
    if (!allAdmin) {
      const gone = boards.filter((b) => m.boards[b.id] && (access[b.id] ?? "none") === "none").map((b) => b.title);
      if (gone.length === 1) out.push(`Remove them from ${gone[0]}`);
      else if (gone.length > 1) {
        const names = gone.length > 3 ? `${gone.slice(0, 3).join(", ")} and ${gone.length - 3} more` : `${gone.slice(0, -1).join(", ")} and ${gone[gone.length - 1]}`;
        out.push(`Remove them from ${gone.length} boards: ${names}`);
      }
    }
    return out;
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
    // Saves that take something away ask first; plain edits save straight away.
    // Runs for the footer button and for Enter (the form's hidden submit) alike.
    if (mode === "edit" && member) {
      const lost = losses(member);
      if (lost.length) {
        const ok = await confirm({
          title: self ? "Save these changes?" : `Save changes to ${member.display_name}?`,
          message: (
            <>
              Saving will:
              <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                {lost.map((x) => (
                  <li key={x}>{x}.</li>
                ))}
              </ul>
            </>
          ),
          confirmLabel: "Save changes",
          danger: true,
        });
        if (!ok) return;
      }
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
      // Trello / Miro / Deliveries roles (admins can set them, never on themselves).
      let boardErr: string | null = null;
      if (id && !self) {
        const { error } = await supabase
          .from("profile")
          .update({
            trello_role: trelloRole === "same" ? null : trelloRole,
            miro_role: miroRole === "same" ? null : miroRole,
            delivery_role: deliveryRole,
          } as never)
          .eq("id", id);
        if (error) boardErr = `Trello / Miro / Deliveries access: ${error.message}`;
      }
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
          <Label info="Prepare deliveries, upload the work and send review links to clients. Everyone on a project still sees its deliveries and feedback.">Deliveries</Label>
          {role === "admin" ? (
            <p className="text-sm text-muted">Admins can always prepare deliveries and send them to clients.</p>
          ) : (
            <>
              <Segmented<"manage" | "none">
                value={deliveryRole}
                onChange={setDeliveryRole}
                disabled={self}
                options={[
                  { value: "manage", label: "Can prepare and send" },
                  { value: "none", label: "No access" },
                ]}
              />
            </>
          )}
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
              <Label htmlFor="em" info="Only for notifications and email-to-card. Sign-in stays username + password.">Email for notifications</Label>
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
              ) : null}
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

        <MemberPhones memberId={mode === "edit" ? member?.id ?? null : null} />

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
                <div className="flex items-center gap-2 px-3 h-11 sm:h-9 border-b border-line bg-inset text-sm">
                  <Search size={13} className="text-subtle shrink-0" />
                  <input
                    className="flex-1 min-w-0 bg-transparent outline-none text-ink placeholder:text-subtle text-lg sm:text-base"
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

/**
 * The WhatsApp numbers the bot knows someone by (wa_member): as many as they
 * use. Added or removed at once (an admin's link, like Alerts > Groups).
 * The brain trusts only these, never a number someone typed on their own card.
 */
function MemberPhones({ memberId }: { memberId: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const phones = useQuery({ queryKey: ["member-phones", memberId], queryFn: () => fetchMemberPhones(memberId!), enabled: !!memberId });
  const change = useMutation({
    mutationFn: ({ phone, on }: { phone: string; on: boolean }) => linkNumber(phone, on ? memberId : null),
    onSuccess: (_r, { on }) => {
      if (on) setDraft("");
      void qc.invalidateQueries({ queryKey: ["member-phones", memberId] });
      void qc.invalidateQueries({ queryKey: ["watch-groups"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change the number", description: e.message }),
  });
  const value = draft.trim() ? normalizeWhatsapp(draft) : "";
  const bad = !!value && !WHATSAPP_RE.test(value);
  return (
    <section>
      <div className="mb-2">
        <div className="text-sm font-medium text-ink">WhatsApp numbers the bot knows them by</div>
        <div className="text-xs text-muted">Every number they write to the bot from. Changes are saved at once.</div>
      </div>
      {!memberId ? (
        <Hint>Add their numbers after you create them.</Hint>
      ) : (
        <div className="space-y-2">
          {(phones.data ?? []).length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {(phones.data ?? []).map((ph) => (
                <li key={ph} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-inset pl-3 pr-1 h-8 text-sm text-ink tabular-nums">
                  +{ph}
                  <button
                    type="button"
                    aria-label={`Remove +${ph}`}
                    className="grid place-items-center h-6 w-6 rounded-full text-muted hover:bg-border/70 hover:text-ink"
                    disabled={change.isPending}
                    onClick={() => change.mutate({ phone: ph, on: false })}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {phones.isSuccess && !phones.data.length && <Hint>No number yet: the bot doesn't know them on WhatsApp.</Hint>}
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value && !bad) change.mutate({ phone: value, on: true });
            }}
          >
            <Input
              aria-label="Add a WhatsApp number"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="201001234567"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={bad}
              className={cn("w-56 max-sm:h-10", bad && "border-danger")}
            />
            <Button type="submit" size="sm" disabled={!value || bad} loading={change.isPending && change.variables?.on}>
              Add number
            </Button>
          </form>
          {bad && <FieldError>Use digits only, country code first. Example: 201001234567</FieldError>}
        </div>
      )}
    </section>
  );
}
