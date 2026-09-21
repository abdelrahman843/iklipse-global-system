import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UserCog, ShieldCheck, ShieldOff } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { PermissionKey, Profile } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError, Hint, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { adminApi } from "@/lib/adminApi";
import { PERMISSION_GROUPS, DEFAULT_MEMBER_PERMISSIONS, ALL_PERMISSIONS } from "@/lib/permissions";

interface Row extends Profile {
  permissions: PermissionKey[];
}

async function fetchMembers(): Promise<Row[]> {
  const { data: profiles, error } = await supabase
    .from("profile")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const { data: perms, error: pErr } = await supabase
    .from("user_permission")
    .select("user_id, permission");
  if (pErr) throw pErr;
  const permRows = (perms ?? []) as { user_id: string; permission: PermissionKey }[];
  const map = new Map<string, PermissionKey[]>();
  for (const r of permRows) {
    const list = map.get(r.user_id) ?? [];
    list.push(r.permission);
    map.set(r.user_id, list);
  }
  return ((profiles ?? []) as Profile[]).map((p) => ({
    ...p,
    permissions: map.get(p.id) ?? [],
  }));
}

export function UsersPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["users"], queryFn: fetchMembers });
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter(
      (r) =>
        r.display_name.toLowerCase().includes(q) ||
        r.username.toLowerCase().includes(q) ||
        r.role.toLowerCase().includes(q),
    );
  }, [data, query]);

  const toggleActive = useMutation({
    mutationFn: (r: Row) => adminApi.updateMember({ user_id: r.id, is_active: !r.is_active }),
    onSuccess: (_, r) => {
      toast.push({
        kind: "success",
        title: r.is_active ? "Member deactivated" : "Member reactivated",
      });
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
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-ink">Users</h1>
          <p className="text-sm text-muted">Manage employee accounts and permissions.</p>
        </div>
        <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)}>
          Add member
        </Button>
      </div>

      <div className="mb-3 max-w-sm">
        <div className="flex items-center gap-2 rounded-md border border-border bg-white px-2.5 h-9 text-sm">
          <Search size={14} className="text-subtle" />
          <input
            className="flex-1 bg-transparent outline-none"
            placeholder="Search by name, username, role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-white shadow-card">
        <table className="w-full text-sm">
          <thead className="bg-surface/60 text-muted text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Member</th>
              <th className="text-left px-4 py-2 font-medium">Username</th>
              <th className="text-left px-4 py-2 font-medium">Role</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Permissions</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="No members yet" description="Add your first employee to get started." />
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-middle">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={r.display_name} src={r.avatar_url} size={30} />
                    <div>
                      <div className="font-medium text-ink">{r.display_name}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted">@{r.username}</td>
                <td className="px-4 py-2.5">
                  {r.role === "admin" ? (
                    <Badge tone="accent">Admin</Badge>
                  ) : (
                    <Badge>Member</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {r.is_active ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge tone="danger">Deactivated</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {r.role === "admin"
                    ? "All (admin)"
                    : r.permissions.length
                      ? `${r.permissions.length} of ${ALL_PERMISSIONS.length}`
                      : "None"}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconLeft={<UserCog size={14} />}
                      onClick={() => setEditing(r)}
                    >
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
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <MemberFormModal
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["users"] });
          }}
        />
      )}
      {editing && (
        <MemberFormModal
          mode="edit"
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["users"] });
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Create/edit modal
// ============================================================================

interface FormModalProps {
  mode: "create" | "edit";
  member?: Row;
  onClose: () => void;
  onSaved: () => void;
}

function MemberFormModal({ mode, member, onClose, onSaved }: FormModalProps) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(member?.display_name ?? "");
  const [username, setUsername] = useState(member?.username ?? "");
  const [role, setRole] = useState<"admin" | "member">(member?.role ?? "member");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<Set<PermissionKey>>(
    new Set(member?.permissions ?? DEFAULT_MEMBER_PERMISSIONS),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const togglePerm = (p: PermissionKey) =>
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!displayName.trim() || !username.trim()) {
      setErr("Display name and username are required.");
      return;
    }
    if (mode === "create" && password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const perms = role === "admin" ? [] : Array.from(permissions); // admin bypasses granular perms
      if (mode === "create") {
        await adminApi.createMember({
          display_name: displayName.trim(),
          username: username.trim(),
          role,
          password,
          permissions: perms,
        });
        toast.push({ kind: "success", title: "Member created" });
      } else if (member) {
        await adminApi.updateMember({
          user_id: member.id,
          display_name: displayName.trim(),
          username: username.trim(),
          role,
          permissions: perms,
          new_password: password ? password : undefined,
        });
        toast.push({ kind: "success", title: "Member updated" });
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={mode === "create" ? "Add member" : `Edit ${member?.display_name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {mode === "create" ? "Create member" : "Save changes"}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="dn">Display name</Label>
          <Input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="un">Username</Label>
          <Input id="un" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Hint>Used for sign-in. Lowercase letters, digits, dot, dash, underscore.</Hint>
        </div>
        <div>
          <Label htmlFor="pw">{mode === "create" ? "Password" : "Reset password (optional)"}</Label>
          <Input
            id="pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "edit" ? "Leave blank to keep the current password" : ""}
          />
          <Hint>Minimum 8 characters.</Hint>
        </div>
        <div>
          <Label>Role</Label>
          <div className="flex gap-2">
            <RoleChip current={role} value="member" onSelect={setRole}>
              Member
            </RoleChip>
            <RoleChip current={role} value="admin" onSelect={setRole}>
              Admin
            </RoleChip>
          </div>
          <Hint>
            Admin bypasses all permission checks. Members get exactly the permissions selected below.
          </Hint>
        </div>

        <div className="md:col-span-2">
          <Label>Permissions</Label>
          {role === "admin" ? (
            <Textarea
              readOnly
              className="bg-surface"
              rows={3}
              value="Admins have every permission by default and cannot be constrained here."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {PERMISSION_GROUPS.map((g) => (
                <div key={g.label} className="rounded-md border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-semibold text-ink">{g.label}</div>
                    <button
                      type="button"
                      className="text-xs text-accent hover:underline"
                      onClick={() =>
                        setPermissions((prev) => {
                          const next = new Set(prev);
                          const all = g.perms.every((p) => next.has(p.key));
                          for (const p of g.perms) {
                            if (all) next.delete(p.key);
                            else next.add(p.key);
                          }
                          return next;
                        })
                      }
                    >
                      {g.perms.every((p) => permissions.has(p.key)) ? "Clear group" : "Select group"}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {g.perms.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={permissions.has(p.key)}
                          onChange={() => togglePerm(p.key)}
                          className="accent-accent"
                        />
                        <span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="md:col-span-2">
          <FieldError>{err}</FieldError>
        </div>
      </form>
    </Modal>
  );
}

function RoleChip({
  current,
  value,
  onSelect,
  children,
}: {
  current: "admin" | "member";
  value: "admin" | "member";
  onSelect: (v: "admin" | "member") => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={
        active
          ? "px-3 h-9 rounded-md border border-accent bg-accent-soft text-accent text-sm font-medium"
          : "px-3 h-9 rounded-md border border-border bg-white text-ink hover:bg-surface text-sm"
      }
    >
      {children}
    </button>
  );
}
