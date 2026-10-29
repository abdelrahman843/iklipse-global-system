import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Save } from "lucide-react";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { useDesign } from "@/lib/design/store";
import { fetchVersions, restoreVersion, saveVersion } from "@/lib/design/sync";
import { TextField } from "./fields";

// -----------------------------------------------------------------------------
// Version history: named snapshots of the whole document (kept on the
// server, newest 100). Restoring saves what's there first as a version.
// -----------------------------------------------------------------------------

export function VersionsPanel({ boardId }: { boardId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = useDesign((s) => s.canEdit);
  const q = useQuery({ queryKey: ["design-versions", boardId], queryFn: () => fetchVersions(boardId) });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const save = async () => {
    setBusy("save");
    try {
      await saveVersion(boardId, label.trim() || null);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["design-versions", boardId] });
      toast.push({ kind: "success", title: "Version saved" });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't save the version", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const restore = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Restore this version?",
      message: `The design goes back to "${name}" for everyone. What's there now is saved as a version first, so you can come back to it.`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setBusy(id);
    try {
      await restoreVersion(boardId, id);
      qc.invalidateQueries({ queryKey: ["design-versions", boardId] });
      toast.push({ kind: "success", title: "Version restored" });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't restore", description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      {canEdit && (
        <div className="p-3 border-b border-border space-y-1.5">
          <TextField value={label} onChange={setLabel} placeholder="Name this version (optional)" />
          <button className="w-full h-7 rounded bg-accent text-white text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-60" onClick={save} disabled={!!busy}>
            {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save version
          </button>
        </div>
      )}
      {q.isLoading && <p className="p-3 text-xs text-subtle">Loading…</p>}
      {q.error && <p className="p-3 text-xs text-danger">{(q.error as Error).message}</p>}
      {q.data && !q.data.length && <p className="p-3 text-xs text-subtle">No saved versions yet.</p>}
      {q.data?.map((v) => {
        const name = v.label || (v.auto ? "Automatic" : "Untitled version");
        return (
          <div key={v.id} className="px-3 py-2 border-b border-border flex items-center gap-2">
            <History size={14} className="text-subtle shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-ink truncate">{name}</div>
              <div className="text-[11px] text-subtle">
                {relativeTime(v.created_at)} · {v.profile?.display_name ?? "Someone"} · {v.node_count} layers
              </div>
            </div>
            {canEdit && (
              <button className="h-7 px-2 rounded bg-inset text-xs text-ink hover:bg-hover disabled:opacity-50" disabled={!!busy} onClick={() => restore(v.id, name)}>
                {busy === v.id ? <Loader2 size={12} className="animate-spin" /> : "Restore"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
