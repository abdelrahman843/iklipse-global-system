import type {
  BoardRole,
  CommentPolicy,
  MemberPolicy,
  PermissionKey,
  Role,
  Workspace,
} from "./database.types";

// ============================================================================
// Trello-style access model.
//
//   Workspace role  admin | member | guest      (who you are in the company)
//   Board role      admin | normal | observer   (what you do on one board)
//   + board settings (visibility, commenting, who adds members)
//   + workspace settings (who creates/deletes boards, who adds guests)
//
// The database enforces all of it (migration 0013). The PermissionKey strings
// are kept as capability names so UI code keeps asking can("pm.edit_card").
// ============================================================================

export type BoardAccess = BoardRole | "viewer" | null;

export const WORKSPACE_ROLES: {
  value: Role;
  label: string;
  summary: string;
  points: string[];
}[] = [
  {
    value: "admin",
    label: "Admin",
    summary: "Runs the workspace.",
    points: [
      "Admin on every board, including private ones",
      "Adds, edits and deactivates users",
      "Changes workspace settings",
    ],
  },
  {
    value: "member",
    label: "Member",
    summary: "Regular employee.",
    points: [
      "Sees and joins workspace-visible boards",
      "Creates boards (if workspace allows)",
      "Gets a board role on each board they join",
    ],
  },
  {
    value: "guest",
    label: "Guest",
    summary: "Outside collaborator.",
    points: [
      "Sees only boards they're added to",
      "Can't create boards or browse the workspace",
      "Board role decides what they can do there",
    ],
  },
];

export const BOARD_ROLES: { value: BoardRole; label: string; summary: string }[] = [
  { value: "admin", label: "Admin", summary: "Everything, plus board settings and members" },
  { value: "normal", label: "Member", summary: "Create, edit, move and archive lists and cards" },
  { value: "observer", label: "Observer", summary: "Read-only. Can comment if the board allows it" },
];

export const boardRoleLabel = (r: BoardAccess) =>
  r === "normal" ? "Member" : r === "viewer" ? "Viewer" : r ? r[0].toUpperCase() + r.slice(1) : "";

export const workspaceRoleLabel = (r: Role) => WORKSPACE_ROLES.find((x) => x.value === r)?.label ?? r;

export const COMMENT_POLICIES: { value: CommentPolicy; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "members", label: "Members" },
  { value: "observers", label: "Members and observers" },
  { value: "workspace", label: "Workspace members" },
];

// ---------------------------------------------------------------- mapping --

// Anyone who can see the board.
const VIEW_CAPS = new Set<PermissionKey>([
  "pm.view",
  "pm.search",
  "pm.calendar_view",
  "pm.table_view",
  "pm.timeline_view",
  "pm.dashboard_view",
  "pm.view_automation",
  "pm.view_activity",
  "pm.manage_notifications",
  "pm.export",
]);

// Board admins and normal members.
const EDIT_CAPS = new Set<PermissionKey>([
  "pm.create_list",
  "pm.edit_list",
  "pm.move_list",
  "pm.archive_list",
  "pm.create_card",
  "pm.edit_card",
  "pm.move_card",
  "pm.archive_card",
  "pm.delete_card",
  "pm.copy_card",
  "pm.manage_labels",
  "pm.manage_members",
  "pm.manage_dates",
  "pm.manage_checklists",
  "pm.manage_attachments",
  "pm.manage_custom_fields",
  "pm.manage_templates",
  "pm.manage_automation",
  "pm.execute_automation",
]);

export interface BoardAccessInfo {
  access: BoardAccess;
  can_edit: boolean;
  can_comment: boolean;
  manage_members: boolean;
  delete_board: boolean;
}

export const NO_ACCESS: BoardAccessInfo = {
  access: null,
  can_edit: false,
  can_comment: false,
  manage_members: false,
  delete_board: false,
};

/** Capability check for one board, from the server's my_board_access(). */
export function boardCan(info: BoardAccessInfo, cap: PermissionKey): boolean {
  if (!info.access) return false;
  if (VIEW_CAPS.has(cap)) return true;
  if (EDIT_CAPS.has(cap)) return info.can_edit;
  switch (cap) {
    case "pm.manage_comments":
      return info.can_comment;
    case "pm.manage_board_members":
      return info.manage_members;
    case "pm.edit_board":
      return info.access === "admin";
    case "pm.delete_board":
      return info.delete_board;
    default:
      return false;
  }
}

/** Workspace-level capability (outside any board). */
export function workspaceCan(
  role: Role | null,
  ws: Pick<Workspace, "board_create_policy"> | null,
  cap: PermissionKey,
): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  if (cap === "pm.view" || cap === "pm.search") return true;
  if (cap === "pm.create_board") return role === "member" && (ws?.board_create_policy ?? "members") === "members";
  return false;
}

export const POLICY_LABEL: Record<MemberPolicy, string> = {
  admins: "Admins only",
  members: "All members",
};

// What each role can do — rendered as the matrix on the Users page.
export const ROLE_MATRIX: { label: string; admin: boolean | string; normal: boolean | string; observer: boolean | string }[] = [
  { label: "View board, cards and attachments", admin: true, normal: true, observer: true },
  { label: "Calendar, table, timeline, dashboard", admin: true, normal: true, observer: true },
  { label: "Comment on cards", admin: "Per board setting", normal: "Per board setting", observer: "Per board setting" },
  { label: "Create, edit, move, archive cards & lists", admin: true, normal: true, observer: false },
  { label: "Labels, dates, checklists, attachments", admin: true, normal: true, observer: false },
  { label: "Automation rules", admin: true, normal: true, observer: "View only" },
  { label: "Add / remove board members", admin: true, normal: "If board allows", observer: false },
  { label: "Change member roles", admin: true, normal: false, observer: false },
  { label: "Board settings & visibility", admin: true, normal: false, observer: false },
  { label: "Delete board", admin: "Per workspace setting", normal: false, observer: false },
];
