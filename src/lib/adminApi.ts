import { supabase } from "./supabase";
import type { Role } from "./database.types";

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
  role?: Role;
  avatar_url?: string | null;
}

export interface UpdateMemberInput {
  user_id: string;
  display_name?: string;
  username?: string;
  role?: Role;
  is_active?: boolean;
  avatar_url?: string | null;
  new_password?: string;
}

export const adminApi = {
  createMember: async (input: CreateMemberInput) => {
    const res = await invoke<{ user_id: string }>("admin-create-member", input);
    // Older deployments of admin-create-member only know admin/member; the
    // update function passes the role straight through, so set guest after.
    if (input.role === "guest") {
      await invoke("admin-update-member", { user_id: res.user_id, role: "guest" });
    }
    return res;
  },
  updateMember: (input: UpdateMemberInput) => invoke<{ ok: true }>("admin-update-member", input),
};
