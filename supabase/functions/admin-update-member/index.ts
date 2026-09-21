import {
  cors,
  json,
  requireAdmin,
  serviceClient,
  toResponse,
  HttpError,
  localEmail,
} from "../_shared/admin.ts";

interface Payload {
  user_id: string;
  display_name?: string;
  username?: string;
  role?: "admin" | "member";
  is_active?: boolean;
  avatar_url?: string | null;
  permissions?: string[]; // full replacement set
  new_password?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  try {
    const callerId = await requireAdmin(req);
    const body = (await req.json()) as Partial<Payload>;
    if (!body.user_id) throw new HttpError(400, "user_id required");

    const admin = serviceClient();

    // Guard: an admin cannot deactivate themselves or demote themselves — prevents lockout.
    if (body.user_id === callerId) {
      if (body.is_active === false) throw new HttpError(400, "You cannot deactivate yourself");
      if (body.role && body.role !== "admin") throw new HttpError(400, "You cannot change your own role");
    }

    // Profile updates.
    const profileUpdate: Record<string, unknown> = {};
    if (body.display_name !== undefined) profileUpdate.display_name = body.display_name;
    if (body.avatar_url !== undefined) profileUpdate.avatar_url = body.avatar_url;
    if (body.role !== undefined) profileUpdate.role = body.role;
    if (body.is_active !== undefined) profileUpdate.is_active = body.is_active;

    if (body.username !== undefined) {
      if (!/^[a-z0-9._-]{3,32}$/i.test(body.username)) {
        throw new HttpError(400, "Username must be 3–32 chars: letters, digits, . _ -");
      }
      const { data: dup } = await admin
        .from("profile")
        .select("id")
        .ilike("username", body.username)
        .neq("id", body.user_id)
        .maybeSingle();
      if (dup) throw new HttpError(409, "Username already exists");
      profileUpdate.username = body.username;
      // Keep the synthetic auth email in sync so future sign-ins with the new username work.
      const { error: emailErr } = await admin.auth.admin.updateUserById(body.user_id, {
        email: localEmail(body.username),
      });
      if (emailErr) throw new HttpError(400, emailErr.message);
    }

    if (Object.keys(profileUpdate).length) {
      const { error } = await admin.from("profile").update(profileUpdate).eq("id", body.user_id);
      if (error) throw new HttpError(400, error.message);
    }

    if (body.new_password) {
      if (body.new_password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
      const { error } = await admin.auth.admin.updateUserById(body.user_id, {
        password: body.new_password,
      });
      if (error) throw new HttpError(400, error.message);
    }

    if (Array.isArray(body.permissions)) {
      // Full replacement.
      const { error: delErr } = await admin
        .from("user_permission")
        .delete()
        .eq("user_id", body.user_id);
      if (delErr) throw new HttpError(400, delErr.message);
      if (body.permissions.length) {
        const rows = body.permissions.map((permission) => ({
          user_id: body.user_id!,
          permission,
        }));
        const { error: insErr } = await admin.from("user_permission").insert(rows);
        if (insErr) throw new HttpError(400, insErr.message);
      }
    }

    // If we deactivated the user, sign out all their sessions so any live tab is booted.
    if (body.is_active === false) {
      await admin.auth.admin.signOut(body.user_id);
    }

    return json({ ok: true });
  } catch (e) {
    return toResponse(e);
  }
});
