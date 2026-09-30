import { Fragment, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import type { PermissionKey } from "@/lib/database.types";
import { BOARD_VIEWS, viewAllowed, type BoardView } from "@/components/pm/BoardViewSwitcher";

const VIEW_NAMES: Record<BoardView, string> = {
  board: "Board",
  calendar: "Calendar",
  table: "Table",
  timeline: "Timeline",
  dashboard: "Dashboard",
  archive: "Archive",
};

interface Row {
  keys: ReactNode;
  label: string;
  hint?: string;
  /** Hidden when the viewer can't do it on this board. */
  perm?: PermissionKey;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-md border border-border bg-inset text-xs font-semibold text-ink shadow-card">
      {children}
    </kbd>
  );
}

// Board keyboard shortcuts (opened with "?"). Only lists what the viewer can
// actually do here.
export function ShortcutsHelp({
  open,
  onClose,
  can,
}: {
  open: boolean;
  onClose: () => void;
  can: (perm: PermissionKey) => boolean;
}) {
  const views = BOARD_VIEWS.map((v, i) => ({ v, n: i + 1 })).filter(({ v }) => viewAllowed(v, can));
  const first = views[0]?.n ?? 1;
  const last = views.at(-1)?.n ?? 1;

  const sections: { title: string; hint?: string; rows: Row[] }[] = [
    {
      title: "Cards",
      hint: "Point at a card, then press a key.",
      rows: [
        { keys: <Kbd>Enter</Kbd>, label: "Open card" },
        { keys: <Kbd>c</Kbd>, label: "Archive card", perm: "pm.archive_card" },
        { keys: <Kbd>d</Kbd>, label: "Mark due date complete or incomplete", perm: "pm.manage_dates" },
        { keys: <Kbd>Space</Kbd>, label: "Join or leave card", perm: "pm.manage_members" },
      ],
    },
    {
      title: "Board",
      rows: [
        { keys: <Kbd>f</Kbd>, label: "Open filters" },
        { keys: <Kbd>/</Kbd>, label: "Filter by keyword" },
        { keys: <Kbd>q</Kbd>, label: "Only cards assigned to me" },
        { keys: <Kbd>x</Kbd>, label: "Clear all filters" },
        {
          keys: (
            <>
              <Kbd>{first}</Kbd>
              <span className="text-xs text-subtle">to</span>
              <Kbd>{last}</Kbd>
            </>
          ),
          label: "Switch view",
          hint: views.map(({ v, n }) => `${n} ${VIEW_NAMES[v]}`).join(", "),
        },
        { keys: <Kbd>?</Kbd>, label: "Show keyboard shortcuts" },
        { keys: <Kbd>Esc</Kbd>, label: "Close a card, menu or dialog" },
      ],
    },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <table className="w-full text-sm">
        <tbody>
          {sections.map((s, si) => (
            <Fragment key={s.title}>
              <tr>
                <th colSpan={2} className={si > 0 ? "pt-5 pb-1.5 text-left" : "pb-1.5 text-left"}>
                  <span className="block text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">{s.title}</span>
                  {s.hint && <span className="block mt-0.5 text-xs font-normal text-muted">{s.hint}</span>}
                </th>
              </tr>
              {s.rows
                .filter((r) => !r.perm || can(r.perm))
                .map((r) => (
                  <tr key={r.label} className="border-t border-line">
                    <td className="w-28 py-2 pr-3 align-top">
                      <span className="inline-flex items-center gap-1">{r.keys}</span>
                    </td>
                    <td className="py-2 align-top text-ink">
                      {r.label}
                      {r.hint && <span className="block mt-0.5 text-xs text-muted">{r.hint}</span>}
                    </td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
