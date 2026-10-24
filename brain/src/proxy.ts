// The Anthropic key stays in this process. Claude Code calls the API through
// this proxy on 127.0.0.1 with a token made at start-up (ANTHROPIC_BASE_URL,
// ANTHROPIC_API_KEY in its environment); the proxy swaps it for the real key.
// A shell command can't use it: the sandbox gives it no way to this machine,
// and the token is no good anywhere else.

import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "x-api-key", "authorization"]);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function keyProxy(o: { key: string; host?: string }): Promise<{ url: string; token: string; close: () => void }> {
  const token = `brain-${randomBytes(24).toString("hex")}`;
  const upstream = o.host ?? "api.anthropic.com";
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const given = String(req.headers["x-api-key"] ?? auth);
    if (!same(given, token)) {
      res.writeHead(401).end();
      return;
    }
    if (!req.url?.startsWith("/v1/")) {
      res.writeHead(404).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = { "x-api-key": o.key, host: upstream };
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    const up = https.request({ host: upstream, path: req.url, method: req.method, headers }, (r) => {
      const back: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) back[k] = v;
      res.writeHead(r.statusCode ?? 502, back);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      done({ url: `http://127.0.0.1:${port}`, token, close: () => server.close() });
    });
  });
}
