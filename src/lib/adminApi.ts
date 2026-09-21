import { supabase } from "./supabase";
import type { PermissionKey } from "./database.types";

async function invoke<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body as Record<string, unknown>,
  });
  if (error) {
    // Edge Functions surface their message via error.message or error.context
    // depending on Supabase JS version. Prefer server-supplied error text when present.
    const msg =
      (error as { context?: { error?: string } })?.context?.error ??
      error.message ??
      "Request failed";
    throw new Error(msg);
  }
  return data as T;
}

export interface CreateMemberInput {
  username: string;
  display_name: string;
  password: string;
  role?: "admin" | "member";
  permissions?: PermissionKey[];
  avatar_url?: string | null;
}

export interface UpdateMemberInput {
  user_id: string;
  display_name?: string;
  username?: string;
  role?: "admin" | "member";
  is_active?: boolean;
  avatar_url?: string | null;
  permissions?: PermissionKey[];
  new_password?: string;
}

export const adminApi = {
  createMember: (input: CreateMemberInput) =>
    invoke<{ user_id: string }>("admin-create-member", input),
  updateMember: (input: UpdateMemberInput) => invoke<{ ok: true }>("admin-update-member", input),
};
