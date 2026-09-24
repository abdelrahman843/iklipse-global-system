import { supabase } from "./supabase";
import type { Role } from "./database.types";

async function invoke<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    body: body as Record<string, unknown>,
  });
  if (error) {
    // On a non-2xx reply supabase-js puts the raw Response in error.context;
    // read the function's { error } body so the real reason reaches the user.
    let msg: string | undefined;
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const b = (await ctx.clone().json()) as { error?: string };
        msg = b?.error;
      } catch {
        /* not JSON */
      }
    } else {
      msg = (ctx as { error?: string } | undefined)?.error;
    }
    throw new Error(msg ?? error.message ?? "Request failed");
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
