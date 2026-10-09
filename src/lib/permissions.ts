import type {
  BoardRole,
  TeamAccess,
  WbRole,
  CommentPolicy,
  MemberPolicy,
  PermissionKey,
  ProductRoleValue,
  Profile,
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

// ---------------------------------------------------------- whiteboards --
// Miro's model (migration 0039). Each role sits on a board role underneath:
// owner / co-owner = admin, editor = member, commenter / viewer = observer.
export const WB_ROLES: { value: WbRole; label: string; summary: string }[] = [
  { value: "owner", label: "Owner", summary: "Everything, and can hand the board to someone else" },
  { value: "coowner", label: "Co-owner", summary: "Edit, invite people and change sharing settings" },
  { value: "editor", label: "Editor", summary: "Edit and comment" },
  { value: "commenter", label: "Commenter", summary: "View and comment" },
  { value: "viewer", label: "Viewer", summary: "View only" },
];

export const TEAM_ACCESS: { value: TeamAccess; label: string; summary: string }[] = [
  { value: "none", label: "No access", summary: "Only people invited to the board" },
  { value: "view", label: "Can view", summary: "Everyone in the workspace can open it" },
  { value: "comment", label: "Can comment", summary: "Everyone in the workspace can comment" },
  { value: "edit", label: "Can edit", summary: "Everyone in the workspace can edit" },
];

export const wbRoleLabel = (r: WbRole | null | undefined) => WB_ROLES.find((x) => x.value === r)?.label ?? "";

const WB_RANK: Record<WbRole, number> = { viewer: 0, commenter: 1, editor: 2, coowner: 3, owner: 4 };

/**
 * What I can do on a whiteboard: my own role, raised to what the server says
 * I may do (the workspace's level can be higher than an invite).
 */
export function wbEffectiveRole(info: BoardAccessInfo): WbRole | null {
  if (!info.access) return null;
  // Workspace admins act as co-owners everywhere.
  if (info.access === "admin" && !info.wb_role) return "coowner";
  let r: WbRole = info.wb_role ?? "viewer";
  if (info.can_comment && WB_RANK[r] < WB_RANK.commenter) r = "commenter";
  if (info.can_edit && WB_RANK[r] < WB_RANK.editor) r = "editor";
  return r;
}

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
  /** Whiteboards (0039): my own Miro role, the workspace's level, copy rule. */
  wb_role?: WbRole | null;
  team_access?: TeamAccess | null;
  allow_copy?: boolean | null;
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
// ------------------------------------------------------------- products --
// Trello (kanban boards) and Miro (whiteboards) each have their own role
// (migration 0044): admin in one, member or no access in the other, etc.
export type Product = "kanban" | "whiteboard";

/** Someone's role in one product: their own setting, else the workspace role. null = no access. */
export function productRole(p: Pick<Profile, "role" | "trello_role" | "miro_role"> | null | undefined, kind: Product): Role | null {
  if (!p) return null;
  const r = (kind === "whiteboard" ? p.miro_role : p.trello_role) ?? p.role;
  return r === "none" ? null : r;
}

export const PRODUCT_ROLE_OPTIONS: { value: ProductRoleValue | "same"; label: string }[] = [
  { value: "same", label: "Same as workspace" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "guest", label: "Guest" },
  { value: "none", label: "No access" },
];

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
  { label: "Delete board", admin: "Workspace admins only", normal: false, observer: false },
];

// What each whiteboard role can do (Miro) — the Roles tab shows this next to
// the board matrix.
export const WB_ROLE_MATRIX: { label: string; owner: boolean | string; coowner: boolean | string; editor: boolean | string; commenter: boolean | string; viewer: boolean | string }[] = [
  { label: "Open the board, follow people, present", owner: true, coowner: true, editor: true, commenter: true, viewer: true },
  { label: "Comment and vote", owner: true, coowner: true, editor: true, commenter: true, viewer: "Votes only" },
  { label: "Add, edit, move and delete content", owner: true, coowner: true, editor: true, commenter: false, viewer: false },
  { label: "Timer and voting sessions", owner: true, coowner: true, editor: true, commenter: false, viewer: false },
  { label: "Copy content and export", owner: true, coowner: true, editor: true, commenter: "If the board allows", viewer: "If the board allows" },
  { label: "Invite people", owner: true, coowner: true, editor: "If the board allows", commenter: false, viewer: false },
  { label: "Change roles and sharing settings", owner: true, coowner: true, editor: false, commenter: false, viewer: false },
  { label: "Transfer ownership", owner: true, coowner: false, editor: false, commenter: false, viewer: false },
  { label: "Delete the board", owner: "Workspace admins only", coowner: false, editor: false, commenter: false, viewer: false },
];
