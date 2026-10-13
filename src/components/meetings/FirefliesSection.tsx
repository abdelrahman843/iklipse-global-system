import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, AudioLines, Plus, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Hint } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { connectFireflies, disconnectFireflies, syncFireflies, type FirefliesAccount } from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// Connected accounts > Fireflies: any number of accounts, each added with its
// API key (Fireflies has no sign-in flow for other apps). The key goes to the
// server and never comes back.
// -----------------------------------------------------------------------------

const MAX = 10;

export function FirefliesSection({ accounts }: { accounts: FirefliesAccount[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["connections"] });
    void qc.invalidateQueries({ queryKey: ["meetings"] });
  };

  const sync = useMutation({
    mutationFn: (a: FirefliesAccount) => syncFireflies(a.id),
    onSuccess: (r) => {
      refresh();
      if (r.errors.length) toast.push({ kind: "error", title: "Didn't sync", description: r.errors.join(" ") });
      else toast.push({ kind: "success", title: "Up to date" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't sync", description: e.message }),
  });
  const drop = useMutation({
    mutationFn: (a: FirefliesAccount) => disconnectFireflies(a.id),
    onSuccess: (_d, a) => {
      refresh();
      void qc.invalidateQueries({ queryKey: ["meetings-shared"] });
      toast.push({ kind: "success", title: `${a.email ?? "Fireflies"} disconnected` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't disconnect", description: e.message }),
  });

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2 flex-1">
          <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
            <AudioLines size={12} />
          </span>
          Fireflies
          {accounts.length > 0 && <span className="text-xs font-normal text-subtle">{accounts.length} connected</span>}
        </h2>
        {accounts.length > 0 && (
          <Link to="/meetings" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
            <AudioLines size={14} /> Open Meetings
          </Link>
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line">
        {accounts.length === 0 && (
          <div className="px-4 py-4 text-sm text-muted">
            Connect one or more Fireflies accounts to see every meeting they were in, with the summary and transcript, and share them.
          </div>
        )}
        {accounts.map((a) => (
          <div key={a.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink truncate">{a.email ?? a.name ?? "Fireflies account"}</div>
              <div className="text-xs text-muted mt-0.5">
                {[a.name && a.email ? a.name : null, `${a.meetings} ${a.meetings === 1 ? "meeting" : "meetings"}`, a.last_sync_at ? `synced ${relativeTime(a.last_sync_at)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {a.last_error && (
                <div className="mt-1 text-xs text-warn inline-flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {a.last_error}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" className="max-sm:h-10" iconLeft={<RefreshCw size={14} />} loading={sync.isPending && sync.variables?.id === a.id} onClick={() => sync.mutate(a)}>
                Sync
              </Button>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Unplug size={14} />}
                className="max-sm:h-10"
                loading={drop.isPending && drop.variables?.id === a.id}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Disconnect ${a.email ?? "this account"}?`,
                    message: "Its meetings leave iklipse, and so do the shares and email links. Nothing changes in Fireflies.",
                    confirmLabel: "Disconnect",
                    danger: true,
                  });
                  if (ok) drop.mutate(a);
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ))}
        <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex-1 text-xs text-muted">Each account is added with its own API key. Up to {MAX}.</div>
          <Button
            variant={accounts.length ? "secondary" : "primary"}
            size="sm"
            iconLeft={<Plus size={14} />}
            disabled={accounts.length >= MAX}
            className="max-sm:h-10"
            onClick={() => setAdding(true)}
          >
            {accounts.length ? "Add Fireflies account" : "Connect Fireflies"}
          </Button>
        </div>
      </div>
      {adding && <AddModal onClose={() => setAdding(false)} onDone={refresh} />}
    </section>
  );
}

function AddModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const add = useMutation({
    mutationFn: () => connectFireflies(key.trim()),
    onSuccess: (r) => {
      onDone();
      toast.push({
        kind: "success",
        title: `${r.email ?? "Fireflies"} connected`,
        description: r.meetings ? `${r.meetings} meetings so far; older ones keep coming in.` : "Meetings show up in a few minutes.",
      });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't connect", description: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect a Fireflies account"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} disabled={key.trim().length < 10} onClick={() => add.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ol className="list-decimal pl-5 space-y-1 text-sm text-ink">
          <li>
            Sign in to{" "}
            <a href="https://app.fireflies.ai/integrations/custom/fireflies" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              fireflies.ai
            </a>{" "}
            with the account you want to add.
          </li>
          <li>Open Integrations, then Fireflies API.</li>
          <li>Copy the API key and paste it here.</li>
        </ol>
        <div>
          <Label htmlFor="ff-key">API key</Label>
          <Input
            id="ff-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim().length >= 10 && add.mutate()}
            autoFocus
          />
          <Hint>It's kept on the server only. Getting the first meetings can take up to a minute.</Hint>
        </div>
      </div>
    </Modal>
  );
}
