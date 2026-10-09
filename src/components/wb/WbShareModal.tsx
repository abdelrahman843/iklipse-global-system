import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Globe2, Link2, Lock, Search, UserPlus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { supabase } from "@/lib/supabase";
import type { MemberPolicy, Profile, TeamAccess, WbRole } from "@/lib/database.types";
import { TEAM_ACCESS, WB_ROLES, productRole, wbEffectiveRole, wbRoleLabel } from "@/lib/permissions";
import type { BoardAccessValue } from "@/lib/pm/boardAccess";
import type { WbBoard } from "@/lib/wb/api";
import { useWbPeople } from "@/lib/wb/people";

// -----------------------------------------------------------------------------
// Share dialog for whiteboards, Miro style: invite with a role, what the whole
// workspace gets, people with access, and the sharing settings. The database
// enforces every rule (migration 0039); this only hides what you can't do.
// -----------------------------------------------------------------------------

interface WbMember {
  user_id: string;
  wb_role: WbRole;
  created_at: string;
  profile: Profile;
}

async function fetchWbMembers(boardId: string): Promise<WbMember[]> {
  const { data, error } = await supabase
    .from("board_member")
    .select("user_id, wb_role, created_at, profile:profile!inner(*)")
    .eq("board_id", boardId)
    .order("created_at");
  if (error) throw error;
  const rank: Record<WbRole, number> = { owner: 0, coowner: 1, editor: 2, commenter: 3, viewer: 4 };
  return ((data ?? []) as unknown as (Omit<WbMember, "profile"> & { profile: Profile | Profile[] })[])
    .map((r) => ({ ...r, wb_role: r.wb_role ?? "viewer", profile: Array.isArray(r.profile) ? r.profile[0]! : r.profile }))
    .sort((a, b) => rank[a.wb_role] - rank[b.wb_role] || a.profile.display_name.localeCompare(b.profile.display_name));
}

const ROLE_FOR_BOARD: Record<WbRole, "admin" | "normal" | "observer"> = {
  owner: "admin",
  coowner: "admin",
  editor: "normal",
  commenter: "observer",
  viewer: "observer",
};

export function WbShareModal({
  board,
  access,
  onClose,
  initialTab = "people",
}: {
  board: WbBoard;
  access: BoardAccessValue;
  onClose: () => void;
  initialTab?: "people" | "settings";
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const people = useWbPeople();
  const [tab, setTab] = useState(initialTab);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Profile | null>(null);
  const [inviteRole, setInviteRole] = useState<WbRole>("editor");

  const me = wbEffectiveRole(access);
  const isBoardAdmin = access.access === "admin"; // owner, co-owner or workspace admin
  const canInvite = access.manage_members;
  const myOwn = access.wb_role ?? null;
  const canTransfer = myOwn === "owner" || (access.access === "admin" && !myOwn);

  const members = useQuery({ queryKey: ["board-members", board.id, "wb"], queryFn: () => fetchWbMembers(board.id) });
  const memberIds = useMemo(() => new Set((members.data ?? []).map((m) => m.user_id)), [members.data]);
  const candidates = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return (people.data?.list ?? [])
      .filter((p) => p.is_active && !memberIds.has(p.id) && (p.display_name + " " + p.username).toLowerCase().includes(s))
      .slice(0, 8);
  }, [q, people.data, memberIds]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["board-members", board.id] });
    qc.invalidateQueries({ queryKey: ["board-access", board.id] });
    qc.invalidateQueries({ queryKey: ["wb-board", board.id] });
    qc.invalidateQueries({ queryKey: ["boards"] });
  };
  const fail = (title: string) => (e: Error) => toast.push({ kind: "error", title, description: e.message });

  const invite = useMutation({
    mutationFn: async () => {
      if (!pick) return;
      const { error } = await supabase
        .from("board_member")
        .insert({ board_id: board.id, user_id: pick.id, role: ROLE_FOR_BOARD[inviteRole], wb_role: inviteRole });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.push({ kind: "success", title: `${pick?.display_name} can now ${inviteRole === "viewer" ? "view" : inviteRole === "commenter" ? "comment" : "edit"}` });
      setPick(null);
      setQ("");
      refresh();
    },
    onError: fail("Couldn't invite"),
  });

  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: WbRole }) => {
      const { error } = await supabase
        .from("board_member")
        .update({ wb_role: role, role: ROLE_FOR_BOARD[role] })
        .eq("board_id", board.id)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: fail("Couldn't change the role"),
  });

  const remove = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.from("board_member").delete().eq("board_id", board.id).eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: fail("Couldn't remove"),
  });

  const transfer = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("wb_transfer_ownership", { p_board: board.id, p_user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.push({ kind: "success", title: "Ownership transferred" });
      refresh();
    },
    onError: fail("Couldn't transfer ownership"),
  });

  const settings = useMutation({
    mutationFn: async (patch: { wb_team_access?: TeamAccess; wb_allow_copy?: boolean; member_policy?: MemberPolicy }) => {
      const { error } = await supabase.from("board").update(patch).eq("id", board.id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: fail("Couldn't save the setting"),
  });

  const teamAccess = (board.wb_team_access ?? (board.visibility === "private" ? "none" : "view")) as TeamAccess;
  const inviteRoles = WB_ROLES.filter((r) => r.value !== "owner" && (r.value !== "coowner" || isBoardAdmin));

  const copyLink = () => {
    void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/wb/${board.id}`).catch(() => undefined);
    toast.push({ kind: "success", title: "Board link copied" });
  };

  return (
    <Modal open onClose={onClose} size="lg" fitViewport title="Share board">
      <div className="px-3 sm:px-5 pt-1 border-b border-border flex gap-1 shrink-0">
        {(
          [
            ["people", "People"],
            ["settings", "Settings"],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn("relative h-9 px-3 text-sm font-medium transition-colors", tab === t ? "text-ink" : "text-muted hover:text-ink")}
          >
            {label}
            {tab === t && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-5">
        {tab === "people" ? (
          <>
            {/* Invite */}
            {canInvite && (
              <section>
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1 min-w-0">
                    {pick ? (
                      <div className="h-9 flex items-center gap-2 px-2 rounded-md border border-accent bg-surface">
                        <Avatar name={pick.display_name} src={pick.avatar_url} size={22} />
                        <span className="flex-1 min-w-0 truncate text-sm text-ink">{pick.display_name}</span>
                        <button className="text-xs text-muted hover:text-ink" onClick={() => setPick(null)}>
                          Change
                        </button>
                      </div>
                    ) : (
                      <div className="h-10 sm:h-9 flex items-center gap-2 px-2.5 rounded-md border border-border bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
                        <Search size={14} className="text-subtle shrink-0" />
                        <input
                          value={q}
                          onChange={(e) => setQ(e.target.value)}
                          placeholder="Add people by name"
                          aria-label="Add people by name"
                          className="flex-1 min-w-0 bg-transparent outline-none text-ink placeholder:text-subtle text-lg sm:text-sm"
                        />
                      </div>
                    )}
                    {!pick && candidates.length > 0 && (
                      <div className="absolute z-10 left-0 right-0 top-full mt-1 py-1 rounded-lg border border-border bg-surface shadow-raise max-h-64 overflow-auto">
                        {candidates.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => setPick(p as unknown as Profile)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-inset"
                          >
                            <Avatar name={p.display_name} src={p.avatar_url} size={24} />
                            <span className="min-w-0">
                              <span className="block text-sm text-ink truncate">{p.display_name}</span>
                              <span className="block text-xs text-subtle truncate">@{p.username}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Select
                      value={inviteRole}
                      onChange={(v) => setInviteRole(v as WbRole)}
                      options={inviteRoles.map((r) => ({ value: r.value, label: r.label }))}
                      aria-label="Role for the new person"
                      className="w-36"
                    />
                    <Button variant="primary" iconLeft={<UserPlus size={15} />} disabled={!pick} loading={invite.isPending} onClick={() => invite.mutate()}>
                      Invite
                    </Button>
                  </div>
                </div>
              </section>
            )}

            {/* Workspace access */}
            <section className="flex items-center gap-3 rounded-lg border border-border p-3">
              <span className={cn("h-9 w-9 shrink-0 rounded-full grid place-items-center", teamAccess === "none" ? "bg-inset text-muted" : "bg-accent-soft text-accent")}>
                {teamAccess === "none" ? <Lock size={16} /> : <Globe2 size={16} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink">Anyone in the workspace</div>
                <div className="text-xs text-muted">{TEAM_ACCESS.find((t) => t.value === teamAccess)?.summary}. Guests only see what they're invited to.</div>
              </div>
              {isBoardAdmin ? (
                <Select
                  value={teamAccess}
                  onChange={(v) => settings.mutate({ wb_team_access: v as TeamAccess })}
                  options={TEAM_ACCESS.map((t) => ({ value: t.value, label: t.label }))}
                  aria-label="Workspace access"
                  align="right"
                  className="w-36 shrink-0"
                />
              ) : (
                <span className="text-sm text-muted shrink-0">{TEAM_ACCESS.find((t) => t.value === teamAccess)?.label}</span>
              )}
            </section>

            {/* People */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium text-ink">People with access</div>
                {me && <Badge tone="neutral">You: {wbRoleLabel(me)}</Badge>}
              </div>
              {members.isLoading ? (
                <div className="py-6 grid place-items-center">
                  <Spinner />
                </div>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-border">
                  {(members.data ?? []).map((m) => {
                    const self = m.user_id === user?.id;
                    const owner = m.wb_role === "owner";
                    const canChange = isBoardAdmin && !owner;
                    return (
                      <li key={m.user_id} className="flex items-center gap-3 px-3 py-2">
                        <Avatar name={m.profile.display_name} src={m.profile.avatar_url} size={30} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-ink truncate">
                            {m.profile.display_name} {self && <span className="text-subtle">(you)</span>}
                          </div>
                          <div className="text-xs text-subtle truncate">
                            @{m.profile.username}
                            {productRole(m.profile, "whiteboard") === "guest" && " · Guest"}
                          </div>
                        </div>
                        {owner ? (
                          <span className="inline-flex items-center gap-1 text-sm text-ink shrink-0">
                            <Crown size={14} className="text-accent" /> Owner
                          </span>
                        ) : canChange || canTransfer || self ? (
                          <Menu
                            align="right"
                            trigger={
                              <button className="h-8 px-2 rounded-md text-sm text-ink hover:bg-inset shrink-0 inline-flex items-center gap-1">
                                {wbRoleLabel(m.wb_role)}
                                <svg width="10" height="10" viewBox="0 0 10 10" className="text-subtle">
                                  <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
                                </svg>
                              </button>
                            }
                          >
                            {(close) => (
                              <div className="min-w-[240px]">
                                {canChange &&
                                  WB_ROLES.filter((r) => r.value !== "owner").map((r) => (
                                    <MenuItem
                                      key={r.value}
                                      onClick={() => {
                                        close();
                                        if (r.value !== m.wb_role) setRole.mutate({ userId: m.user_id, role: r.value });
                                      }}
                                    >
                                      <span className="block">
                                        <span className={cn("block text-sm", r.value === m.wb_role ? "text-accent font-medium" : "text-ink")}>{r.label}</span>
                                        <span className="block text-xs text-subtle">{r.summary}</span>
                                      </span>
                                    </MenuItem>
                                  ))}
                                {canTransfer && ["admin", "member"].includes(productRole(m.profile, "whiteboard") ?? "") && (
                                  <>
                                    {canChange && <MenuDivider />}
                                    <MenuItem
                                      onClick={async () => {
                                        close();
                                        const ok = await confirm({
                                          title: `Make ${m.profile.display_name} the owner?`,
                                          message: "They get full control of the board. You stay on it as a co-owner.",
                                          confirmLabel: "Transfer ownership",
                                        });
                                        if (ok) transfer.mutate(m.user_id);
                                      }}
                                    >
                                      Transfer ownership
                                    </MenuItem>
                                  </>
                                )}
                                {(canChange || self) && (
                                  <>
                                    <MenuDivider />
                                    <MenuItem
                                      destructive
                                      onClick={async () => {
                                        close();
                                        const ok = await confirm({
                                          title: self ? "Leave this board?" : `Remove ${m.profile.display_name}?`,
                                          message: self
                                            ? "You'll keep only the access the whole workspace has."
                                            : "They'll keep only the access the whole workspace has.",
                                          confirmLabel: self ? "Leave" : "Remove",
                                          danger: true,
                                        });
                                        if (ok) remove.mutate(m.user_id);
                                      }}
                                    >
                                      {self ? "Leave board" : "Remove from board"}
                                    </MenuItem>
                                  </>
                                )}
                              </div>
                            )}
                          </Menu>
                        ) : (
                          <span className="text-sm text-muted shrink-0">{wbRoleLabel(m.wb_role)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        ) : (
          <>
            <section>
              <div className="text-sm font-medium text-ink mb-1">Who can invite people</div>
              <p className="text-xs text-muted mb-2">Owners and co-owners can always invite. Nobody can invite someone above their own role.</p>
              <Segmented<MemberPolicy>
                value={board.member_policy}
                onChange={(v) => settings.mutate({ member_policy: v })}
                disabled={!isBoardAdmin}
                options={[
                  { value: "admins", label: "Owners and co-owners" },
                  { value: "members", label: "Editors too" },
                ]}
              />
            </section>
            <section>
              <Toggle
                checked={board.wb_allow_copy !== false}
                onChange={(v) => settings.mutate({ wb_allow_copy: v })}
                disabled={!isBoardAdmin}
                label="Viewers and commenters can copy and export"
                hint="When off, only editors and above can copy items or download the board as an image."
              />
            </section>
            <section className="rounded-lg border border-border">
              <div className="px-3 py-2 border-b border-line text-sm font-medium text-ink">What each role can do</div>
              <ul className="divide-y divide-line">
                {WB_ROLES.map((r) => (
                  <li key={r.value} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-24 shrink-0 text-ink font-medium">{r.label}</span>
                    <span className="text-muted">{r.summary}</span>
                  </li>
                ))}
              </ul>
            </section>
            {!isBoardAdmin && <p className="text-xs text-subtle">Only owners and co-owners change these settings.</p>}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 sm:px-5 py-3 flex items-center justify-between gap-2">
        <Button variant="secondary" size="sm" iconLeft={<Link2 size={14} />} onClick={copyLink}>
          Copy board link
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
