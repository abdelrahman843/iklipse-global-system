// Account-wide MCP tools: finding boards and people, notifications, the
// person's own profile, and (for workspace admins) people's roles.

import { actions, boardUrl, changed, must, ok, oneOf, optStr, person, str, uuid, UserError, type Args, type Ctx, type Tool } from "./lib.ts";

const ROLES = ["admin", "member", "guest"] as const;
const PRODUCT_ROLES = ["same", "admin", "member", "guest", "none"] as const;

export const accountTools: Tool[] = [
  {
    name: "list_boards",
    title: "List boards",
    description:
      "The Trello boards (lists and cards) and Miro boards (whiteboards) the user can open. Start here to find a board id. Filter by product or words in the title; archived Trello boards with include_archived.",
    inputSchema: {
      type: "object",
      properties: {
        product: { type: "string", enum: ["trello", "miro", "all"] },
        query: { type: "string" },
        include_archived: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, c) => {
      let q = c.db.from("board").select("id, title, kind, description, is_archived, visibility, updated_at").order("updated_at", { ascending: false }).limit(300);
      if (a.include_archived !== true) q = q.eq("is_archived", false);
      if (a.product === "trello") q = q.eq("kind", "kanban");
      if (a.product === "miro") q = q.eq("kind", "whiteboard");
      const qs = optStr(a.query, 100);
      if (qs) q = q.ilike("title", `%${qs.replace(/[%_]/g, "")}%`);
      const [rows, mine] = await Promise.all([q, c.db.from("board_member").select("board_id, role, wb_role").eq("user_id", c.uid)]);
      const roleOf = new Map((must(mine, "Membership") as { board_id: string; role: string; wb_role: string | null }[]).map((m) => [m.board_id, m.wb_role ?? (m.role === "normal" ? "member" : m.role)]));
      return (must(rows, "Boards") as { id: string; title: string; kind: string; description: string | null; is_archived: boolean; visibility: string; updated_at: string }[]).map((b) => ({
        id: b.id, title: b.title, product: b.kind === "whiteboard" ? "miro" : "trello", my_role: roleOf.get(b.id) ?? "not a member",
        visibility: b.visibility, archived: b.is_archived || undefined, description: b.description ?? undefined, updated_at: b.updated_at, url: boardUrl(c, b),
      }));
    },
  },
  {
    name: "list_people",
    title: "List people",
    description: "People in the workspace the user can see (name, @username, role, active), to add to boards and cards or mention with @username.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, c) => {
      let q = c.db.from("profile").select("id, display_name, username, role, trello_role, miro_role, is_active").order("display_name").limit(500);
      const qs = optStr(a.query, 100);
      if (qs) q = q.or(`display_name.ilike.%${qs.replace(/[,()%]/g, "")}%,username.ilike.%${qs.replace(/[,()%]/g, "")}%`);
      return (must(await q, "People") as Record<string, unknown>[]).map((p) => ({
        id: p.id, name: p.display_name, username: `@${p.username}`, role: p.role,
        trello_role: p.trello_role ?? undefined, miro_role: p.miro_role ?? undefined, active: p.is_active,
      }));
    },
  },
  {
    name: "notifications",
    title: "Notifications",
    description:
      "The user's notifications. list {unread_only? (default true), product?: trello|miro|all} newest first; mark_read {ids}; mark_all_read {product?}.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "mark_read", "mark_all_read"] },
        unread_only: { type: "boolean" },
        product: { type: "string", enum: ["trello", "miro", "all"] },
        ids: { type: "array", items: { type: "string" }, maxItems: 500 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a, c) => {
      const fetch = async (unreadOnly: boolean) => {
        let q = c.db.from("notification").select("id, kind, data, created_at, read_at, board_id, card_id, board:board_id(title, kind), card:card_id(title)").order("created_at", { ascending: false }).limit(100);
        if (unreadOnly) q = q.is("read_at", null);
        const rows = must(await q, "Notifications") as { id: string; kind: string; data: Record<string, unknown>; created_at: string; read_at: string | null; board_id: string | null; card_id: string | null; board: { title: string; kind: string } | null; card: { title: string } | null }[];
        return rows.filter((n) => !a.product || a.product === "all" || (a.product === "miro") === (n.board?.kind === "whiteboard" || (!n.board && n.kind.startsWith("wb_"))));
      };
      return actions(a, {
        list: async () =>
          (await fetch(a.unread_only !== false)).map((n) => ({
            id: n.id, kind: n.kind, product: n.board?.kind === "whiteboard" || n.kind.startsWith("wb_") ? "miro" : "trello",
            board: n.board?.title, card: n.card?.title, by: typeof n.data?.by === "string" ? n.data.by : undefined,
            text: typeof n.data?.excerpt === "string" ? n.data.excerpt : typeof n.data?.text === "string" ? n.data.text : undefined,
            at: n.created_at, unread: !n.read_at,
          })),
        mark_read: async () => {
          const ids = (Array.isArray(a.ids) ? a.ids : []).map((x) => uuid(x, "ids[]"));
          if (!ids.length) throw new UserError("ids is empty");
          await ok(c.db.from("notification").update({ read_at: new Date().toISOString() }).in("id", ids), "Mark read");
          return { marked_read: ids.length };
        },
        mark_all_read: async () => {
          const ids = (await fetch(true)).map((n) => n.id);
          if (ids.length) await ok(c.db.from("notification").update({ read_at: new Date().toISOString() }).in("id", ids), "Mark read");
          return { marked_read: ids.length };
        },
      });
    },
  },
  {
    name: "my_account",
    title: "My account",
    description: "The signed-in user. get: name, @username, workspace role, Trello and Miro roles. set_name {name}: change the display name.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["get", "set_name"] }, name: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a, c) =>
      actions(a, {
        get: async () => {
          const p = must(await c.db.from("profile").select("id, display_name, username, role, trello_role, miro_role").eq("id", c.uid).single(), "Profile") as Record<string, unknown>;
          const eff = (v: unknown) => (v ?? p.role) === "none" ? "no access" : v ?? p.role;
          return { id: p.id, name: p.display_name, username: `@${p.username}`, workspace_role: p.role, trello_role: eff(p.trello_role), miro_role: eff(p.miro_role) };
        },
        set_name: async () => {
          await changed(c.db.from("profile").update({ display_name: str(a.name, "name", 80) }).eq("id", c.uid).select("id"), "Change name");
          return { name: a.name };
        },
      }),
  },
  {
    name: "manage_people",
    title: "Manage people (workspace admins)",
    description:
      "Workspace admins only. set_role {user, role: admin|member|guest}; set_product_roles {user, trello_role?, miro_role?: same|admin|member|guest|none}; deactivate / activate {user}; sign_out {user} (ends their sessions everywhere). Ask the user before deactivating or signing someone out.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_role", "set_product_roles", "deactivate", "activate", "sign_out"] },
        user: { type: "string" },
        role: { type: "string", enum: [...ROLES] },
        trello_role: { type: "string", enum: [...PRODUCT_ROLES] },
        miro_role: { type: "string", enum: [...PRODUCT_ROLES] },
      },
      required: ["action", "user"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (a: Args, c: Ctx) => {
      const isAdmin = must(await c.db.rpc("is_admin"), "Check admin");
      if (!isAdmin) throw new UserError("Only workspace admins can manage people");
      const p = await person(c, a.user, "user", true);
      if (p.id === c.uid && a.action !== "set_product_roles") throw new UserError("You can't change your own role or status");
      return actions(a, {
        set_role: async () => {
          await changed(c.db.from("profile").update({ role: oneOf(a.role, "role", ROLES) }).eq("id", p.id).select("id"), "Set role");
          return { user: p.display_name, role: a.role };
        },
        set_product_roles: async () => {
          if (p.id === c.uid) throw new UserError("You can't change your own roles");
          const patch: Record<string, unknown> = {};
          if (a.trello_role !== undefined) patch.trello_role = a.trello_role === "same" ? null : oneOf(a.trello_role, "trello_role", PRODUCT_ROLES);
          if (a.miro_role !== undefined) patch.miro_role = a.miro_role === "same" ? null : oneOf(a.miro_role, "miro_role", PRODUCT_ROLES);
          if (!Object.keys(patch).length) throw new UserError("Give trello_role and/or miro_role");
          await changed(c.db.from("profile").update(patch).eq("id", p.id).select("id"), "Set roles");
          return { user: p.display_name, ...patch };
        },
        deactivate: async () => {
          await changed(c.db.from("profile").update({ is_active: false }).eq("id", p.id).select("id"), "Deactivate");
          return { user: p.display_name, active: false };
        },
        activate: async () => {
          await changed(c.db.from("profile").update({ is_active: true }).eq("id", p.id).select("id"), "Activate");
          return { user: p.display_name, active: true };
        },
        sign_out: async () => {
          await ok(c.db.rpc("admin_sign_out", { p_user: p.id }), "Sign out");
          return { user: p.display_name, signed_out: true };
        },
      });
    },
  },
];
