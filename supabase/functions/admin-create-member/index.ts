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
  username: string;
  display_name: string;
  password: string;
  role?: "admin" | "member";
  permissions?: string[];
  avatar_url?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  try {
    await requireAdmin(req);

    const body = (await req.json()) as Partial<Payload>;
    if (!body.username || !body.display_name || !body.password) {
      throw new HttpError(400, "username, display_name and password are required");
    }
    if (!/^[a-z0-9._-]{3,32}$/i.test(body.username)) {
      throw new HttpError(400, "Username must be 3–32 chars: letters, digits, . _ -");
    }
    if (body.password.length < 8) {
      throw new HttpError(400, "Password must be at least 8 characters");
    }
    const role = body.role === "admin" ? "admin" : "member";

    const admin = serviceClient();

    // Ensure username not taken.
    const { data: existing } = await admin
      .from("profile")
      .select("id")
      .ilike("username", body.username)
      .maybeSingle();
    if (existing) throw new HttpError(409, "Username already exists");

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: localEmail(body.username),
      password: body.password,
      email_confirm: true,
      user_metadata: {
        username: body.username,
        display_name: body.display_name,
        role,
      },
    });
    if (createErr || !created?.user) {
      throw new HttpError(400, createErr?.message ?? "Failed to create user");
    }
    const uid = created.user.id;

    // Trigger on_auth_user_created materialises the profile row. Update avatar if provided.
    if (body.avatar_url) {
      await admin.from("profile").update({ avatar_url: body.avatar_url }).eq("id", uid);
    }

    // Apply permission set.
    if (Array.isArray(body.permissions) && body.permissions.length) {
      const rows = body.permissions.map((permission) => ({ user_id: uid, permission }));
      const { error: permErr } = await admin.from("user_permission").insert(rows);
      if (permErr) throw new HttpError(400, `Permissions: ${permErr.message}`);
    }

    return json({ user_id: uid });
  } catch (e) {
    return toResponse(e);
  }
});
