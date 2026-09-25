import { useMemo, useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Globe2, Lock, Search, ShieldCheck, Trash2, UserPlus, Users2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { Spinner } from "@/components/ui/Spinner";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/cn";
import type { Board, BoardRole, CommentPolicy, MemberPolicy, Profile } from "@/lib/database.types";
import { BOARD_ROLES, COMMENT_POLICIES, boardRoleLabel } from "@/lib/permissions";
import type { BoardAccessValue } from "@/lib/pm/boardAccess";
import {
  addBoardMember,
  deleteBoard,
  fetchBoardMembers,
  removeBoardMember,
  setBoardMemberRole,
  updateBoard,
  type BoardMemberRow,
  type BoardSettings,
} from "@/lib/pm/boardApi";

type Tab = "members" | "settings";

async function fetchActiveProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profile").select("*").eq("is_active", true).order("display_name");
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export function ShareBoardModal({
  board,
  access,
  onClose,
  initialTab = "members",
}: {
  board: Board;
  access: BoardAccessValue;
  onClose: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <Modal open onClose={onClose} size="lg" fitViewport title="Share board">
      <div className="px-3 sm:px-5 pt-1 border-b border-border flex gap-1 shrink-0">
        {(["members", "settings"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "relative h-9 px-3 text-sm font-medium transition-colors",
              tab === t ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {t === "members" ? "Members" : "Settings"}
            <span
              className={cn(
                "absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent transition-transform duration-200 origin-center",
                tab === t ? "scale-x-100" : "scale-x-0",
              )}
            />
          </button>
        ))}
      </div>
      <div key={tab} className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 view-enter">
        {tab === "members" ? (
          <MembersTab board={board} access={access} onClose={onClose} />
        ) : (
          <SettingsTab board={board} access={access} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}

// ================================================================ Members ==

function MembersTab({ board, access, onClose }: { board: Board; access: BoardAccessValue; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { user, workspace, isAdmin: wsAdmin } = useAuth();
  const members = useQuery({ queryKey: ["board-members", board.id], queryFn: () => fetchBoardMembers(board.id) });
  const people = useQuery({ queryKey: ["profiles-active"], queryFn: fetchActiveProfiles, staleTime: 60_000 });

  const iAmAdmin = access.access === "admin";
  const canInvite = access.manage_members;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["board-members", board.id] });
    qc.invalidateQueries({ queryKey: ["board", board.id] });
    qc.invalidateQueries({ queryKey: ["board-access", board.id] });
    qc.invalidateQueries({ queryKey: ["boards"] });
  };
  const fail = (title: string) => (e: Error) => toast.push({ kind: "error", title, description: e.message });

  const add = useMutation({
    mutationFn: (v: { userId: string; role: BoardRole }) => addBoardMember(board.id, v.userId, v.role),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Added to board" });
      refresh();
    },
    onError: fail("Couldn't add member"),
  });
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: BoardRole }) => setBoardMemberRole(board.id, v.userId, v.role),
    onSuccess: refresh,
    onError: fail("Couldn't change role"),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeBoardMember(board.id, userId),
    onSuccess: (_, userId) => {
      if (userId === user?.id) {
        toast.push({ kind: "info", title: "You left the board" });
        onClose();
        refresh();
        // A private board disappears once you leave it.
        if (board.visibility === "private" && !wsAdmin) nav("/pm/boards");
        return;
      }
      toast.push({ kind: "info", title: "Removed from board" });
      refresh();
    },
    onError: fail("Couldn't remove member"),
  });

  const memberIds = useMemo(() => new Set((members.data ?? []).map((m) => m.user_id)), [members.data]);
  const guestsBlocked = !wsAdmin && workspace?.guest_policy === "admins";
  const candidates = useMemo(
    () => (people.data ?? []).filter((p) => !memberIds.has(p.id) && !(guestsBlocked && p.role === "guest")),
    [people.data, memberIds, guestsBlocked],
  );

  const adminCount = (members.data ?? []).filter((m) => m.role === "admin").length;

  return (
    <div className="space-y-5">
      {canInvite ? (
        <AddMemberRow candidates={candidates} allowAdmin={iAmAdmin} busy={add.isPending} onAdd={(v) => add.mutate(v)} />
      ) : (
        <p className="text-sm text-muted rounded-md bg-inset border border-line px-3 py-2">
          {access.access === "normal"
            ? "Only board admins can add people to this board."
            : "You can't add people to this board."}
        </p>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="eyebrow text-subtle">Board members · {members.data?.length ?? 0}</div>
        </div>
        {members.isLoading ? (
          <div className="py-8 grid place-items-center">
            <Spinner />
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-border overflow-hidden">
            {(members.data ?? []).map((m, i) => (
              <MemberRow
                key={m.user_id}
                m={m}
                i={i}
                me={m.user_id === user?.id}
                canChangeRole={iAmAdmin}
                canRemove={iAmAdmin || (canInvite && m.role !== "admin")}
                lastAdmin={m.role === "admin" && adminCount <= 1}
                busy={
                  (setRole.isPending && setRole.variables?.userId === m.user_id) ||
                  (remove.isPending && remove.variables === m.user_id)
                }
                onRole={(role) => setRole.mutate({ userId: m.user_id, role })}
                onRemove={() => remove.mutate(m.user_id)}
              />
            ))}
          </ul>
        )}
        <p className="text-xs text-subtle mt-2 flex items-center gap-1.5">
          <ShieldCheck size={12} /> Workspace admins can manage every board, even without being a member.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-2">
        {BOARD_ROLES.map((r) => (
          <div key={r.value} className="rounded-md border border-line bg-inset px-3 py-2">
            <div className="text-sm font-semibold text-ink">{r.label}</div>
            <div className="text-xs text-muted leading-snug mt-0.5">{r.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddMemberRow({
  candidates,
  allowAdmin,
  busy,
  onAdd,
}: {
  candidates: Profile[];
  allowAdmin: boolean;
  busy: boolean;
  onAdd: (v: { userId: string; role: BoardRole }) => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Profile | null>(null);
  const [role, setRole] = useState<BoardRole>("normal");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return candidates
      .filter((p) => !s || p.display_name.toLowerCase().includes(s) || p.username.toLowerCase().includes(s))
      .slice(0, 8);
  }, [candidates, q]);

  const submit = () => {
    if (!picked) return;
    onAdd({ userId: picked.id, role });
    setPicked(null);
    setQ("");
  };

  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <div ref={boxRef} className="relative flex-1 min-w-0">
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 h-9 text-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
          {picked ? (
            <>
              <Avatar name={picked.display_name} src={picked.avatar_url} size={20} />
              <span className="flex-1 truncate text-ink">{picked.display_name}</span>
              <button
                className="text-xs text-muted hover:text-ink"
                onClick={() => {
                  setPicked(null);
                  setOpen(true);
                }}
              >
                Change
              </button>
            </>
          ) : (
            <>
              <Search size={14} className="text-subtle shrink-0" />
              <input
                className="flex-1 min-w-0 bg-transparent outline-none text-ink placeholder:text-subtle"
                placeholder="Name or username"
                value={q}
                onFocus={() => setOpen(true)}
                onChange={(e) => {
                  setQ(e.target.value);
                  setOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matches[0]) {
                    setPicked(matches[0]);
                    setOpen(false);
                  }
                }}
              />
            </>
          )}
        </div>
        {open && !picked && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-md border border-border bg-surface shadow-pop py-1 max-h-64 overflow-y-auto animate-slide-down origin-top">
            {matches.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted">
                {candidates.length ? "No one matches." : "Everyone is already on this board."}
              </div>
            ) : (
              matches.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setPicked(p);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-inset transition-colors"
                >
                  <Avatar name={p.display_name} src={p.avatar_url} size={26} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-ink truncate">{p.display_name}</span>
                    <span className="block text-xs text-subtle truncate">@{p.username}</span>
                  </span>
                  {p.role === "guest" && <Badge>Guest</Badge>}
                  {p.role === "admin" && <Badge tone="accent">Workspace admin</Badge>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <RoleSelect value={role} onChange={setRole} allowAdmin={allowAdmin} />
      <Button variant="primary" iconLeft={<UserPlus size={15} />} disabled={!picked} loading={busy} onClick={submit}>
        Share
      </Button>
    </div>
  );
}

function RoleSelect({
  value,
  onChange,
  allowAdmin,
  disabled,
}: {
  value: BoardRole;
  onChange: (r: BoardRole) => void;
  allowAdmin: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu
      align="right"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className="h-9 px-3 inline-flex items-center justify-between gap-2 rounded-md border border-border bg-surface text-sm text-ink hover:bg-inset disabled:opacity-60 disabled:hover:bg-surface min-w-[120px] transition-colors"
        >
          {boardRoleLabel(value)}
          <ChevronDown size={14} className="text-subtle" />
        </button>
      }
    >
      {(close) =>
        BOARD_ROLES.filter((r) => allowAdmin || r.value !== "admin").map((r) => (
          <MenuItem
            key={r.value}
            onClick={() => {
              onChange(r.value);
              close();
            }}
          >
            <span className="flex items-start gap-2 max-w-[260px]">
              <Check size={14} className={cn("mt-0.5 shrink-0", r.value === value ? "text-accent" : "opacity-0")} />
              <span>
                <span className="block font-medium">{r.label}</span>
                <span className="block text-xs text-muted leading-snug whitespace-normal">{r.summary}</span>
              </span>
            </span>
          </MenuItem>
        ))
      }
    </Menu>
  );
}

function MemberRow({
  m,
  i,
  me,
  canChangeRole,
  canRemove,
  lastAdmin,
  busy,
  onRole,
  onRemove,
}: {
  m: BoardMemberRow;
  i: number;
  me: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  lastAdmin: boolean;
  busy: boolean;
  onRole: (r: BoardRole) => void;
  onRemove: () => void;
}) {
  const p = m.profile;
  const editable = canChangeRole || canRemove || me;
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 bg-surface rise" style={{ "--i": i } as React.CSSProperties}>
      <div className="relative shrink-0">
        <Avatar name={p.display_name} src={p.avatar_url} size={32} />
        {m.role === "admin" && (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-accent text-white grid place-items-center ring-2 ring-surface"
            title="Board admin"
          >
            <ChevronDown size={9} className="rotate-180" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-ink truncate">
          {p.display_name} {me && <span className="text-subtle font-normal">(you)</span>}
        </div>
        <div className="text-xs text-subtle truncate flex items-center gap-1.5">
          @{p.username}
          {p.role === "admin" && <span className="text-accent">· Workspace admin</span>}
          {p.role === "guest" && <span>· Guest</span>}
        </div>
      </div>
      {busy && <Spinner />}
      {editable ? (
        <Menu
          align="right"
          trigger={
            <button className="h-8 min-w-[108px] px-2.5 inline-flex items-center justify-between gap-1.5 rounded-md border border-border bg-surface text-sm text-ink hover:bg-inset transition-colors">
              {boardRoleLabel(m.role)}
              <ChevronDown size={13} className="text-subtle" />
            </button>
          }
        >
          {(close) => (
            <>
              {canChangeRole &&
                BOARD_ROLES.map((r) => (
                  <MenuItem
                    key={r.value}
                    disabled={lastAdmin && r.value !== "admin"}
                    onClick={() => {
                      if (r.value !== m.role) onRole(r.value);
                      close();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Check size={14} className={r.value === m.role ? "text-accent" : "opacity-0"} />
                      {r.label}
                    </span>
                  </MenuItem>
                ))}
              {canChangeRole && (canRemove || me) && <MenuDivider />}
              {(canRemove || me) && (
                <MenuItem
                  destructive
                  disabled={lastAdmin}
                  onClick={() => {
                    close();
                    const msg = me ? "Leave this board?" : `Remove ${p.display_name} from this board?`;
                    if (window.confirm(msg)) onRemove();
                  }}
                >
                  {me ? "Leave board" : "Remove from board"}
                </MenuItem>
              )}
              {lastAdmin && (
                <div className="px-3 pb-1.5 pt-0.5 text-[11px] text-subtle max-w-[220px]">
                  Last admin. Make someone else admin first.
                </div>
              )}
            </>
          )}
        </Menu>
      ) : (
        <span className="text-sm text-muted px-2">{boardRoleLabel(m.role)}</span>
      )}
    </li>
  );
}

// =============================================================== Settings ==

function SettingsTab({ board, access, onClose }: { board: Board; access: BoardAccessValue; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const editable = access.access === "admin";

  const save = useMutation({
    mutationFn: (patch: Partial<BoardSettings>) => updateBoard(board.id, patch),
    onMutate: (patch) => {
      qc.setQueryData(["board", board.id], (b: { board: Board } | undefined) =>
        b ? { ...b, board: { ...b.board, ...patch } } : b,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board-access", board.id] });
      qc.invalidateQueries({ queryKey: ["boards"] });
    },
    onError: (e: Error) => {
      toast.push({ kind: "error", title: "Couldn't save setting", description: e.message });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
    },
  });

  const del = useMutation({
    mutationFn: () => deleteBoard(board.id),
    onSuccess: () => {
      toast.push({ kind: "info", title: "Board deleted" });
      qc.invalidateQueries({ queryKey: ["boards"] });
      onClose();
      nav("/pm/boards");
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete board", description: e.message }),
  });

  return (
    <div className="space-y-6">
      {!editable && (
        <p className="text-sm text-muted rounded-md bg-inset border border-line px-3 py-2">
          Only board admins can change these settings.
        </p>
      )}

      <Section title="Visibility">
        <div className="grid sm:grid-cols-2 gap-2">
          <ChoiceCard
            active={board.visibility === "private"}
            disabled={!editable}
            icon={<Lock size={16} />}
            title="Private"
            text="Only board members can see and edit this board."
            onClick={() => save.mutate({ visibility: "private" })}
          />
          <ChoiceCard
            active={board.visibility === "workspace"}
            disabled={!editable}
            icon={<Globe2 size={16} />}
            title="Workspace"
            text="All workspace members can see it. Guests can't."
            onClick={() => save.mutate({ visibility: "workspace" })}
          />
        </div>
        <Toggle
          disabled={!editable || board.visibility !== "workspace"}
          checked={board.visibility === "workspace" && board.self_join}
          onChange={(v) => save.mutate({ self_join: v })}
          label="Workspace members can join this board"
          hint="Lets anyone in the workspace join as a member without an invite."
        />
      </Section>

      <Section title="Commenting permissions">
        <Segmented<CommentPolicy>
          disabled={!editable}
          value={board.comment_policy}
          options={COMMENT_POLICIES}
          onChange={(v) => save.mutate({ comment_policy: v })}
        />
      </Section>

      <Section title="Adding and removing members">
        <Segmented<MemberPolicy>
          disabled={!editable}
          value={board.member_policy}
          options={[
            { value: "admins", label: "Admins only" },
            { value: "members", label: "All members" },
          ]}
          onChange={(v) => save.mutate({ member_policy: v })}
        />
      </Section>

      {access.delete_board && (
        <Section title="Danger zone">
          <div className="flex items-center gap-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2.5">
            <div className="flex-1 text-sm text-muted">Permanently delete this board, its lists, cards and history.</div>
            <Button
              variant="subtle"
              size="sm"
              className="text-danger"
              iconLeft={<Trash2 size={14} />}
              loading={del.isPending}
              onClick={() => {
                if (window.confirm(`Delete "${board.title}" forever? This can't be undone.`)) del.mutate();
              }}
            >
              Delete board
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function ChoiceCard({
  active,
  disabled,
  icon,
  title,
  text,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => !active && onClick()}
      className={cn(
        "text-left rounded-lg border px-3 py-2.5 transition-[border-color,background-color,box-shadow] duration-150",
        active ? "border-accent bg-accent-soft shadow-card" : "border-border bg-surface hover:border-rule",
        disabled && !active && "opacity-60 hover:border-border cursor-not-allowed",
      )}
    >
      <div className={cn("flex items-center gap-2 text-sm font-semibold", active ? "text-accent" : "text-ink")}>
        {icon}
        {title}
        {active && <Check size={14} className="ml-auto" />}
      </div>
      <div className="text-xs text-muted mt-1 leading-snug">{text}</div>
    </button>
  );
}

/** Avatar stack + Share button for the board header. */
export function BoardShareButton({
  members,
  onClick,
}: {
  members: Profile[];
  onClick: () => void;
}) {
  const shown = members.slice(0, 4);
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="hidden sm:flex -space-x-1.5">
        {shown.map((m) => (
          <span key={m.id} className="rounded-full ring-2 ring-surface" title={m.display_name}>
            <Avatar name={m.display_name} src={m.avatar_url} size={26} />
          </span>
        ))}
        {members.length > shown.length && (
          <span className="h-[26px] min-w-[26px] px-1 rounded-full ring-2 ring-surface bg-inset text-[11px] font-medium text-muted grid place-items-center">
            +{members.length - shown.length}
          </span>
        )}
      </div>
      <Button size="sm" variant="primary" iconLeft={<Users2 size={14} />} onClick={onClick}>
        Share
      </Button>
    </div>
  );
}
