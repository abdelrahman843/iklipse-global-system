// Minimal hand-written database types. Generate a full version with:
//   supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
// once the schema stabilises. Kept manual and small for now so imports type-check.

export type Role = "admin" | "member";

export type PermissionKey =
  | "pm.view"
  | "pm.create_board"
  | "pm.edit_board"
  | "pm.delete_board"
  | "pm.manage_board_members"
  | "pm.create_list"
  | "pm.edit_list"
  | "pm.move_list"
  | "pm.archive_list"
  | "pm.create_card"
  | "pm.edit_card"
  | "pm.move_card"
  | "pm.archive_card"
  | "pm.delete_card"
  | "pm.copy_card"
  | "pm.manage_labels"
  | "pm.manage_members"
  | "pm.manage_dates"
  | "pm.manage_checklists"
  | "pm.manage_attachments"
  | "pm.manage_comments"
  | "pm.manage_custom_fields"
  | "pm.manage_templates"
  | "pm.search"
  | "pm.calendar_view"
  | "pm.table_view"
  | "pm.timeline_view"
  | "pm.dashboard_view"
  | "pm.view_automation"
  | "pm.manage_automation"
  | "pm.execute_automation"
  | "pm.view_activity"
  | "pm.manage_notifications"
  | "pm.export";

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: Role;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Board {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  background: string | null;
  is_archived: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BoardMember {
  board_id: string;
  user_id: string;
  role: "admin" | "normal" | "observer";
  created_at: string;
}

export interface List {
  id: string;
  board_id: string;
  title: string;
  position: string; // lexorank
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Card {
  id: string;
  board_id: string;
  list_id: string;
  short_id: number;
  title: string;
  description: string | null;
  position: string;
  start_date: string | null;
  due_date: string | null;
  due_completed: boolean;
  is_archived: boolean;
  is_template: boolean;
  cover_color: string | null;
  cover_attachment_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Label {
  id: string;
  board_id: string;
  name: string;
  color: string;
  position: string;
}

export interface Checklist {
  id: string;
  card_id: string;
  name: string;
  position: string;
}
export interface ChecklistItem {
  id: string;
  checklist_id: string;
  text: string;
  completed: boolean;
  position: string;
  assignee_id: string | null;
  due_date: string | null;
}

export interface Attachment {
  id: string;
  card_id: string;
  name: string;
  mime_type: string | null;
  size: number | null;
  storage_path: string | null;
  external_url: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface Comment {
  id: string;
  card_id: string;
  author_id: string;
  body: string;
  edited_at: string | null;
  created_at: string;
}

export interface Activity {
  id: string;
  board_id: string;
  card_id: string | null;
  actor_id: string;
  action: string;
  data: unknown;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  board_id: string | null;
  card_id: string | null;
  kind: string;
  data: unknown;
  read_at: string | null;
  created_at: string;
}

// PostgREST-shaped index. `never` on tables we haven't formalised yet.
export interface Database {
  public: {
    Tables: {
      profile: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> };
      user_permission: {
        Row: { user_id: string; permission: PermissionKey };
        Insert: { user_id: string; permission: PermissionKey };
        Update: never;
      };
      board: { Row: Board; Insert: Partial<Board>; Update: Partial<Board> };
      board_member: { Row: BoardMember; Insert: Partial<BoardMember>; Update: Partial<BoardMember> };
      list: { Row: List; Insert: Partial<List>; Update: Partial<List> };
      card: { Row: Card; Insert: Partial<Card>; Update: Partial<Card> };
      label: { Row: Label; Insert: Partial<Label>; Update: Partial<Label> };
      card_label: {
        Row: { card_id: string; label_id: string };
        Insert: { card_id: string; label_id: string };
        Update: never;
      };
      card_member: {
        Row: { card_id: string; user_id: string };
        Insert: { card_id: string; user_id: string };
        Update: never;
      };
      checklist: { Row: Checklist; Insert: Partial<Checklist>; Update: Partial<Checklist> };
      checklist_item: {
        Row: ChecklistItem;
        Insert: Partial<ChecklistItem>;
        Update: Partial<ChecklistItem>;
      };
      attachment: { Row: Attachment; Insert: Partial<Attachment>; Update: Partial<Attachment> };
      comment: { Row: Comment; Insert: Partial<Comment>; Update: Partial<Comment> };
      activity: { Row: Activity; Insert: Partial<Activity>; Update: Partial<Activity> };
      notification: {
        Row: Notification;
        Insert: Partial<Notification>;
        Update: Partial<Notification>;
      };
      subscription: {
        Row: { user_id: string; entity_type: "board" | "list" | "card"; entity_id: string };
        Insert: { user_id: string; entity_type: "board" | "list" | "card"; entity_id: string };
        Update: never;
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_admin: { Args: Record<string, never>; Returns: boolean };
      has_permission: { Args: { p: PermissionKey }; Returns: boolean };
      is_board_member: { Args: { b: string }; Returns: boolean };
      move_card: {
        Args: {
          p_card_id: string;
          p_list_id: string;
          p_prev_position: string | null;
          p_next_position: string | null;
        };
        Returns: string; // new position
      };
      reorder_list: {
        Args: {
          p_list_id: string;
          p_prev_position: string | null;
          p_next_position: string | null;
        };
        Returns: string;
      };
    };
    Enums: {
      role: Role;
      board_role: "admin" | "normal" | "observer";
    };
  };
}
