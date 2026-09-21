import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";
import { Filter, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import type { Label as LabelT, Profile } from "@/lib/database.types";

export interface BoardFilterState {
  keyword: string;
  memberIds: string[];
  labelIds: string[];
  noMembers: boolean;
  noLabels: boolean;
  dueScope: "any" | "overdue" | "week" | "month" | "none";
  onlyMine: boolean;
}

export const DEFAULT_FILTERS: BoardFilterState = {
  keyword: "",
  memberIds: [],
  labelIds: [],
  noMembers: false,
  noLabels: false,
  dueScope: "any",
  onlyMine: false,
};

export function BoardFilters({
  filters,
  setFilters,
  boardMembers,
  boardLabels,
  currentUserId,
}: {
  filters: BoardFilterState;
  setFilters: (f: BoardFilterState) => void;
  boardMembers: Profile[];
  boardLabels: LabelT[];
  currentUserId?: string;
}) {
  const active =
    filters.keyword.trim().length > 0 ||
    filters.memberIds.length > 0 ||
    filters.labelIds.length > 0 ||
    filters.noMembers ||
    filters.noLabels ||
    filters.dueScope !== "any" ||
    filters.onlyMine;

  return (
    <div className="flex items-center gap-2">
      <div className="hidden md:flex items-center gap-2 rounded-md border border-border bg-white px-2.5 h-8 text-sm w-56">
        <Filter size={14} className="text-subtle" />
        <input
          className="flex-1 bg-transparent outline-none"
          placeholder="Filter cards by keyword…"
          value={filters.keyword}
          onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
        />
      </div>

      <Menu
        align="right"
        trigger={
          <Button variant={active ? "primary" : "secondary"} size="sm" iconLeft={<Filter size={14} />}>
            Filters{active ? " (on)" : ""}
          </Button>
        }
      >
        {() => (
          <div className="w-72 p-3 space-y-3 text-sm">
            <div>
              <div className="text-xs font-semibold text-subtle uppercase mb-1">Members</div>
              <label className="flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={filters.onlyMine}
                  onChange={(e) => setFilters({ ...filters, onlyMine: e.target.checked })}
                />
                Assigned to me
              </label>
              <label className="flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={filters.noMembers}
                  onChange={(e) => setFilters({ ...filters, noMembers: e.target.checked })}
                />
                No members
              </label>
              <div className="max-h-32 overflow-auto space-y-1 mt-1">
                {boardMembers.map((m) => {
                  const on = filters.memberIds.includes(m.id);
                  return (
                    <label key={m.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={on}
                        onChange={() =>
                          setFilters({
                            ...filters,
                            memberIds: on
                              ? filters.memberIds.filter((x) => x !== m.id)
                              : [...filters.memberIds, m.id],
                          })
                        }
                      />
                      <Avatar name={m.display_name} src={m.avatar_url} size={18} />
                      <span>{m.display_name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-subtle uppercase mb-1">Labels</div>
              <label className="flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={filters.noLabels}
                  onChange={(e) => setFilters({ ...filters, noLabels: e.target.checked })}
                />
                No labels
              </label>
              <div className="max-h-32 overflow-auto space-y-1 mt-1">
                {boardLabels.map((l) => {
                  const on = filters.labelIds.includes(l.id);
                  return (
                    <label key={l.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={on}
                        onChange={() =>
                          setFilters({
                            ...filters,
                            labelIds: on
                              ? filters.labelIds.filter((x) => x !== l.id)
                              : [...filters.labelIds, l.id],
                          })
                        }
                      />
                      <span className="h-3 w-6 rounded" style={{ background: l.color }} />
                      <span>{l.name || "(unnamed)"}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-subtle uppercase mb-1">Due</div>
              <select
                value={filters.dueScope}
                onChange={(e) =>
                  setFilters({ ...filters, dueScope: e.target.value as BoardFilterState["dueScope"] })
                }
                className="w-full border border-border rounded-md h-8 px-2 bg-white"
              >
                <option value="any">Any</option>
                <option value="overdue">Overdue</option>
                <option value="week">Within a week</option>
                <option value="month">Within a month</option>
                <option value="none">No due date</option>
              </select>
            </div>

            {active && (
              <button
                className="text-xs text-accent hover:underline inline-flex items-center gap-1"
                onClick={() =>
                  setFilters({ ...DEFAULT_FILTERS, keyword: filters.keyword ? "" : "" })
                }
              >
                <X size={12} /> Clear all
              </button>
            )}
            {/* Note: currentUserId is captured by the caller via `onlyMine` behavior. */}
            <div className="hidden">{currentUserId}</div>
          </div>
        )}
      </Menu>
    </div>
  );
}

/**
 * Apply a filter state to a card (client-side). Any-of within each dimension,
 * intersection across dimensions.
 */
export function cardMatchesFilters(args: {
  filters: BoardFilterState;
  card: { id: string; title: string; description: string | null; due_date: string | null };
  memberIds: string[];
  labelIds: string[];
  currentUserId?: string;
}): boolean {
  const { filters, card, memberIds, labelIds, currentUserId } = args;

  if (filters.keyword.trim()) {
    const k = filters.keyword.toLowerCase();
    if (!(card.title.toLowerCase().includes(k) || (card.description ?? "").toLowerCase().includes(k))) {
      return false;
    }
  }

  if (filters.onlyMine && currentUserId && !memberIds.includes(currentUserId)) return false;
  if (filters.noMembers && memberIds.length > 0) return false;
  if (filters.memberIds.length && !filters.memberIds.some((m) => memberIds.includes(m))) return false;

  if (filters.noLabels && labelIds.length > 0) return false;
  if (filters.labelIds.length && !filters.labelIds.some((l) => labelIds.includes(l))) return false;

  if (filters.dueScope !== "any") {
    if (filters.dueScope === "none") {
      if (card.due_date) return false;
    } else {
      if (!card.due_date) return false;
      const d = new Date(card.due_date);
      const now = new Date();
      if (filters.dueScope === "overdue" && !(d < now)) return false;
      const week = new Date();
      week.setDate(week.getDate() + 7);
      const month = new Date();
      month.setMonth(month.getMonth() + 1);
      if (filters.dueScope === "week" && !(d <= week)) return false;
      if (filters.dueScope === "month" && !(d <= month)) return false;
    }
  }

  return true;
}
