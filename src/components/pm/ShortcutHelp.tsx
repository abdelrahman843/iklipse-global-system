import { Modal } from "@/components/ui/Modal";

const ROWS: { keys: string; label: string }[] = [
  { keys: "?", label: "Show this help" },
  { keys: "/", label: "Open search" },
  { keys: "b", label: "Open boards" },
  { keys: "Shift + M", label: "Open my cards" },
  { keys: "Shift + N", label: "Open notifications" },
  { keys: "Enter", label: "Save composer (Cmd/Ctrl+Enter on comments)" },
  { keys: "Esc", label: "Close dialog / composer" },
];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 gap-x-6">
        {ROWS.map((r) => (
          <div key={r.keys} className="flex items-center justify-between border-b border-line py-1.5">
            <div className="text-sm text-ink">{r.label}</div>
            <kbd className="text-xs border border-border rounded px-1.5 py-0.5 bg-surface text-muted">
              {r.keys}
            </kbd>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-subtle">
        Shortcuts are ignored while you're typing in an input.
      </p>
    </Modal>
  );
}
