import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, Globe, Link2, Lock, Send, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FieldError, Label, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  fetchFileAccess,
  fileAccessKey,
  setFileRole,
  setGeneralAccess,
  shareFile,
  unshareFile,
  type FileAccess,
  type FileRole,
} from "@/lib/driveApi";

// -----------------------------------------------------------------------------
// Share a file or folder in Google Drive itself, like Drive's own Share screen:
// add people by email, change or remove what each person may do, and who else
// can open it with the link. The drive function checks the caller may share
// in this Drive (canShare); otherwise it all shows read only.
// -----------------------------------------------------------------------------

const ROLES: { value: FileRole; label: string; verb: string }[] = [
  { value: "reader", label: "Viewer", verb: "view" },
  { value: "commenter", label: "Commenter", verb: "comment" },
  { value: "writer", label: "Editor", verb: "edit" },
];
const OTHER_ROLES: Record<string, string> = { owner: "Owner", organizer: "Manager", fileOrganizer: "Content manager" };
const roleLabel = (r: string | null) => ROLES.find((x) => x.value === r)?.label ?? OTHER_ROLES[r ?? ""] ?? r ?? "";
const isRole = (r: string | null): r is FileRole => ROLES.some((x) => x.value === r);
const REMOVE = "remove";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** "a@x.com, b@y.com c@z.com" -> each address once, lower case. */
const splitEmails = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const uniq = (xs: string[]) => [...new Set(xs)];

export function ShareDriveModal({ account, id, name, onClose }: { account: string; id: string; name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = fileAccessKey(account, id);
  const q = useQuery({ queryKey: key, queryFn: () => fetchFileAccess(account, id) });
  const put = (a: FileAccess) => qc.setQueryData(key, a);

  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<FileRole>("reader");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");

  // What Send sends: the chips plus whatever is still being typed.
  const all = uniq([...emails, ...splitEmails(draft)]);
  const bad = all.filter((e) => !EMAIL.test(e));
  const commit = (text: string) => {
    const add = splitEmails(text);
    if (add.length) setEmails((xs) => uniq([...xs, ...add]));
  };
  const typed = (v: string) => {
    // A comma, space or a pasted list turns what's before it into chips.
    if (!/[\s,;]/.test(v)) return setDraft(v);
    const parts = v.split(/[\s,;]+/);
    const rest = parts.pop() ?? "";
    commit(parts.join(" "));
    setDraft(rest);
  };

  const share = useMutation({
    mutationFn: (to: string[]) => shareFile({ account, id, emails: to, role, notify, ...(notify && message.trim() ? { message: message.trim() } : {}) }),
    onSuccess: (a, to) => {
      put(a);
      toast.push({ kind: "success", title: to.length === 1 ? `Shared with ${to[0]}` : `Shared with ${to.length} people` });
      setEmails([]);
      setDraft("");
      setMessage("");
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't share it", description: e.message }),
  });
  const changeRole = useMutation({
    mutationFn: (v: { permission: string; role: FileRole }) => setFileRole(account, id, v.permission, v.role),
    onSuccess: put,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change the access", description: e.message }),
  });
  const remove = useMutation({
    mutationFn: (permission: string) => unshareFile(account, id, permission),
    onSuccess: put,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't remove the access", description: e.message }),
  });
  const general = useMutation({
    mutationFn: (v: { access: "restricted" | "anyone"; role?: FileRole }) => setGeneralAccess(account, id, v.access, v.role),
    onSuccess: put,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change general access", description: e.message }),
  });

  const a = q.data;
  const canShare = !!a?.canShare;
  const copy = () => {
    if (!a?.link) return;
    navigator.clipboard.writeText(a.link).then(
      () => toast.push({ kind: "success", title: "Link copied" }),
      () => toast.push({ kind: "error", title: "Couldn't copy", description: a.link ?? undefined }),
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={<span className="block truncate">Share “{a?.name ?? name}”</span>}
      size="md"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Button iconLeft={<Link2 size={14} />} disabled={!a?.link} onClick={copy}>
            Copy link
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      {q.isLoading ? (
        <div className="py-12 grid place-items-center text-subtle">
          <Spinner size={20} />
        </div>
      ) : q.error || !a ? (
        <EmptyState icon={<AlertTriangle size={26} />} title="Couldn't load who has access" description={(q.error as Error | null)?.message} />
      ) : (
        <div className="space-y-6">
          {!canShare && <p className="rounded-md border border-line bg-inset px-3 py-2 text-sm text-muted">You can't change who has access in this Drive.</p>}

          {/* Add people */}
          {canShare && (
            <section className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div
                  className={cn(
                    "flex-1 min-w-0 flex flex-wrap items-center gap-1.5 rounded-md border bg-surface px-2 py-1.5 min-h-9 cursor-text",
                    "transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring",
                    bad.length ? "border-danger" : "border-border",
                  )}
                  onClick={(e) => e.currentTarget.querySelector("input")?.focus()}
                >
                  {emails.map((e) => (
                    <span
                      key={e}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1 rounded-full border pl-2 pr-0.5 py-0.5 text-sm",
                        EMAIL.test(e) ? "border-border bg-inset text-ink" : "border-danger/40 bg-danger/10 text-danger",
                      )}
                    >
                      <span className="truncate">{e}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${e}`}
                        onClick={() => setEmails((xs) => xs.filter((x) => x !== e))}
                        className="h-5 w-5 shrink-0 grid place-items-center rounded-full text-subtle hover:text-ink hover:bg-surface"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    // Text, not email: an email field drops the trailing space that makes a chip.
                    type="text"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={draft}
                    onChange={(e) => typed(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit(draft);
                        setDraft("");
                      } else if (e.key === "Backspace" && !draft && emails.length) {
                        setEmails((xs) => xs.slice(0, -1));
                      }
                    }}
                    onBlur={() => {
                      commit(draft);
                      setDraft("");
                    }}
                    placeholder={emails.length ? "" : "Add people by email"}
                    aria-label="Add people by email"
                    // 16px on phones so focusing it doesn't zoom the page on iOS.
                    className="flex-1 min-w-[10rem] h-6 bg-transparent outline-none text-lg sm:text-base text-ink placeholder:text-subtle"
                  />
                </div>
                <Select value={role} onChange={(v) => setRole(v as FileRole)} options={ROLES} aria-label="Role" className="sm:w-36" />
              </div>
              {bad.length > 0 && <FieldError>Fix or remove the addresses in red.</FieldError>}
              {all.length > 0 && (
                <>
                  <label className="flex items-center gap-2 text-sm text-ink cursor-pointer select-none w-fit">
                    <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--c-accent))]" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                    Notify people
                  </label>
                  {notify && (
                    <div>
                      <Label htmlFor="drive-share-message">Message</Label>
                      <Textarea id="drive-share-message" rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional" />
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button variant="primary" iconLeft={<Send size={14} />} disabled={!!bad.length} loading={share.isPending} onClick={() => share.mutate(all)}>
                      Send
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}

          {/* People with access */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">People with access</h3>
            {a.people.length === 0 ? (
              <p className="text-sm text-muted">Nobody yet.</p>
            ) : (
              <ul className="rounded-lg border border-border divide-y divide-line">
                {a.people.map((p) => {
                  const shown = p.name ?? p.email ?? (p.type === "group" ? "A group" : "Someone");
                  const busy = (changeRole.isPending && changeRole.variables?.permission === p.id) || (remove.isPending && remove.variables === p.id);
                  return (
                    <li key={p.id} className="px-3 py-2 flex items-center gap-2.5">
                      <Avatar src={p.photo} name={shown} size={30} className="shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-ink truncate">{shown}</div>
                        {p.email && p.name && <div className="text-xs text-muted truncate">{p.email}</div>}
                        {p.inherited && <div className="text-xs text-subtle">From a parent folder</div>}
                      </div>
                      {busy && <Spinner size={14} className="shrink-0 text-subtle" />}
                      {canShare && isRole(p.role) ? (
                        <Select
                          size="sm"
                          align="right"
                          value={p.role}
                          disabled={busy}
                          onChange={(v) => (v === REMOVE ? remove.mutate(p.id) : changeRole.mutate({ permission: p.id, role: v as FileRole }))}
                          options={[...ROLES, { value: REMOVE, label: "Remove access" }]}
                          aria-label={`Access for ${shown}`}
                          className="w-32 shrink-0"
                        />
                      ) : (
                        <span className="shrink-0 text-sm text-muted">{roleLabel(p.role)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* General access */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">General access</h3>
            <GeneralAccess a={a} busy={general.isPending} onChange={(v) => general.mutate(v)} />
          </section>
        </div>
      )}
    </Modal>
  );
}

function GeneralAccess({
  a,
  busy,
  onChange,
}: {
  a: FileAccess;
  busy: boolean;
  onChange: (v: { access: "restricted" | "anyone"; role?: FileRole }) => void;
}) {
  const g = a.general;
  const at = g.domain ? `Anyone at ${g.domain}` : "Anyone in the organization";
  const verb = ROLES.find((x) => x.value === g.role)?.verb ?? "open";
  const label = g.access === "anyone" ? "Anyone with the link" : g.access === "domain" ? at : "Restricted";
  const help =
    g.access === "anyone"
      ? `Anyone on the internet with the link can ${verb}`
      : g.access === "domain"
        ? `${at} with the link can ${verb}`
        : "Only people with access can open with the link";
  const Icon = g.access === "anyone" ? Globe : g.access === "domain" ? Building2 : Lock;
  const options = [
    { value: "restricted", label: "Restricted" },
    ...(g.access === "domain" ? [{ value: "domain", label: at }] : []),
    { value: "anyone", label: "Anyone with the link" },
  ];

  return (
    <div className="flex items-start gap-3">
      <span className={cn("mt-0.5 h-8 w-8 shrink-0 grid place-items-center rounded-full border border-line", g.access === "restricted" ? "bg-inset text-muted" : "bg-success/10 text-success")}>
        <Icon size={15} />
      </span>
      <div className="min-w-0 flex-1">
        {a.canShare ? (
          <Select
            size="sm"
            value={g.access}
            disabled={busy}
            onChange={(v) => {
              if (v === "restricted") onChange({ access: "restricted" });
              else if (v === "anyone") onChange({ access: "anyone", role: isRole(g.role) ? g.role : "reader" });
            }}
            options={options}
            aria-label="General access"
            className="w-full max-w-[16rem]"
          />
        ) : (
          <div className="text-sm font-medium text-ink">{label}</div>
        )}
        <p className="mt-1 text-xs text-muted">{help}</p>
      </div>
      {busy && <Spinner size={14} className="mt-2 shrink-0 text-subtle" />}
      {g.access !== "restricted" &&
        (a.canShare && g.access === "anyone" ? (
          <Select
            size="sm"
            align="right"
            value={isRole(g.role) ? g.role : "reader"}
            disabled={busy}
            onChange={(v) => onChange({ access: "anyone", role: v as FileRole })}
            options={ROLES}
            aria-label="Role for anyone with the link"
            className="w-32 shrink-0"
          />
        ) : (
          <span className="mt-1.5 shrink-0 text-sm text-muted">{roleLabel(g.role)}</span>
        ))}
    </div>
  );
}
