import type { PermissionKey } from "./database.types";

// Grouped for the Users page permission editor.
export const PERMISSION_GROUPS: {
  label: string;
  perms: { key: PermissionKey; label: string }[];
}[] = [
  {
    label: "Project Management access",
    perms: [
      { key: "pm.view", label: "View project management" },
      { key: "pm.create_board", label: "Create board" },
      { key: "pm.edit_board", label: "Edit board" },
      { key: "pm.delete_board", label: "Delete board" },
      { key: "pm.manage_board_members", label: "Manage board members" },
    ],
  },
  {
    label: "Lists",
    perms: [
      { key: "pm.create_list", label: "Create list" },
      { key: "pm.edit_list", label: "Edit list" },
      { key: "pm.move_list", label: "Move list" },
      { key: "pm.archive_list", label: "Archive list" },
    ],
  },
  {
    label: "Cards",
    perms: [
      { key: "pm.create_card", label: "Create card" },
      { key: "pm.edit_card", label: "Edit card" },
      { key: "pm.move_card", label: "Move card" },
      { key: "pm.archive_card", label: "Archive card" },
      { key: "pm.delete_card", label: "Delete card" },
      { key: "pm.copy_card", label: "Copy card" },
    ],
  },
  {
    label: "Card features",
    perms: [
      { key: "pm.manage_labels", label: "Manage labels" },
      { key: "pm.manage_members", label: "Manage members" },
      { key: "pm.manage_dates", label: "Manage dates" },
      { key: "pm.manage_checklists", label: "Manage checklists" },
      { key: "pm.manage_attachments", label: "Manage attachments" },
      { key: "pm.manage_comments", label: "Manage comments" },
      { key: "pm.manage_custom_fields", label: "Manage custom fields" },
      { key: "pm.manage_templates", label: "Manage templates" },
    ],
  },
  {
    label: "Search & views",
    perms: [
      { key: "pm.search", label: "Search" },
      { key: "pm.calendar_view", label: "Calendar view" },
      { key: "pm.table_view", label: "Table view" },
      { key: "pm.timeline_view", label: "Timeline view" },
      { key: "pm.dashboard_view", label: "Dashboard view" },
    ],
  },
  {
    label: "Automation",
    perms: [
      { key: "pm.view_automation", label: "View automation" },
      { key: "pm.manage_automation", label: "Manage automation" },
      { key: "pm.execute_automation", label: "Execute automation" },
    ],
  },
  {
    label: "Administration",
    perms: [
      { key: "pm.view_activity", label: "View activity" },
      { key: "pm.manage_notifications", label: "Manage notifications" },
      { key: "pm.export", label: "Export data" },
    ],
  },
];

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_GROUPS.flatMap((g) =>
  g.perms.map((p) => p.key),
);

// Default permission set for a new employee. Admin can extend/reduce later.
export const DEFAULT_MEMBER_PERMISSIONS: PermissionKey[] = [
  "pm.view",
  "pm.create_card",
  "pm.edit_card",
  "pm.move_card",
  "pm.archive_card",
  "pm.copy_card",
  "pm.manage_labels",
  "pm.manage_members",
  "pm.manage_dates",
  "pm.manage_checklists",
  "pm.manage_attachments",
  "pm.manage_comments",
  "pm.search",
  "pm.calendar_view",
  "pm.table_view",
  "pm.view_activity",
];
