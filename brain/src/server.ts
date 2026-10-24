// The brain's door (behind Caddy, HTTPS): only the whatsapp-bot function,
// signed with BRAIN_SECRET.
//   GET  /health     { ok, busy, stopped, version }
//   POST /message    a message for the brain (or an edit of one): 202 at once, the answer comes later
//   POST /approval   { approval_id }: something of the brain's own the owner OK'd
//   POST /control    { stopped }: the kill switch

import http from "node:http";
import { signedBy } from "./sign.js";
import type { Incoming } from "./prompt.js";

export interface Handlers {
  secret: string;
  version: string;
  message: (m: Incoming) => "accepted" | "duplicate";
  approval: (id: string) => void;
  control: (stopped: boolean) => void;
  state: () => { busy: number; stopped: boolean };
}

const MAX_BODY = 1 << 20;

function body(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        done(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(null));
  });
}

const send = (res: http.ServerResponse, status: number, out: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));

/** A message as the function sends it, checked enough to run (the function checks the rest). */
export function incoming(x: Record<string, unknown>): Incoming | null {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const sender = (x.sender ?? {}) as Record<string, unknown>;
  if (!/^[0-9a-f-]{36}$/i.test(s(x.run_id)) || !s(x.message_id) || !s(x.reply_chat) || !s(sender.id) || !["owner", "admin", "member", "client"].includes(s(sender.tier))) return null;
  return {
    run_id: s(x.run_id),
    message_id: s(x.message_id),
    chat_id: s(x.chat_id),
    reply_chat: s(x.reply_chat),
    where: ["team", "client", "private"].includes(s(x.where)) ? (s(x.where) as Incoming["where"]) : undefined,
    chat_name: s(x.chat_name) || null,
    via: s(x.via) || null,
    sender: { id: s(sender.id), name: s(sender.name) || "Someone", tier: s(sender.tier) },
    text: s(x.text).slice(0, 20_000),
    quoted: x.quoted && typeof x.quoted === "object" ? { id: s((x.quoted as Record<string, unknown>).id) || null, text: s((x.quoted as Record<string, unknown>).text).slice(0, 8000) } : null,
    files: Array.isArray(x.files) ? (x.files as Record<string, unknown>[]).slice(0, 10).map((f) => ({ kind: s(f.kind), name: s(f.name) || null, text: s(f.text).slice(0, 60_000) })) : [],
    ...(Number(x.edit) > 0 ? { edit: Number(x.edit) } : {}),
    sent_at: s(x.sent_at),
  };
}

export function brainServer(h: Handlers) {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, ...h.state(), version: h.version });
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    const raw = await body(req);
    if (raw === null) return send(res, 413, { error: "Too big" });
    if (!signedBy(h.secret, "to-brain", raw, req.headers["x-brain-signature"] as string | undefined)) return send(res, 403, { error: "Forbidden" });
    let x: Record<string, unknown>;
    try {
      x = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "Bad JSON" });
    }
    if (path === "/message") {
      const m = incoming(x);
      if (!m) return send(res, 400, { error: "Not a message" });
      return send(res, 202, { [h.message(m)]: true });
    }
    if (path === "/approval") {
      const id = typeof x.approval_id === "string" ? x.approval_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, { error: "Which OK?" });
      h.approval(id);
      return send(res, 202, { accepted: true });
    }
    if (path === "/control") {
      if (typeof x.stopped !== "boolean") return send(res, 400, { error: "stopped: true or false" });
      h.control(x.stopped);
      return send(res, 200, { stopped: x.stopped });
    }
    return send(res, 404, { error: "Not found" });
  });
}
