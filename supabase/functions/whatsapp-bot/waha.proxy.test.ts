// WAHA_PROXY read as WAHA wants it (waha.ts proxyOf): the number reaches
// WhatsApp through a home address.
//   npm run test:bot

import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyOf } from "./waha.ts";

test("no secret, no proxy", () => {
  assert.equal(proxyOf(""), null);
  assert.equal(proxyOf("   "), null);
});

test("a full address: the server and its login apart", () => {
  assert.deepEqual(proxyOf("http://user-1:secret@proxy.example.com:8080"), {
    server: "proxy.example.com:8080",
    username: "user-1",
    password: "secret",
  });
});

test("only host:port: no login", () => {
  assert.deepEqual(proxyOf("10.0.0.5:3128"), { server: "10.0.0.5:3128" });
});

test("a password with signs stays encoded, for GOWS to read back", () => {
  assert.deepEqual(proxyOf("http://me:p%40ss%3Aw@gate.example.com:7000"), {
    server: "gate.example.com:7000",
    username: "me",
    password: "p%40ss%3Aw",
  });
});

test("socks, no port or nonsense: refused", () => {
  assert.throws(() => proxyOf("socks5://u:p@gate.example.com:1080"), /HTTP proxy/);
  assert.throws(() => proxyOf("http://gate.example.com"), /port/);
  assert.throws(() => proxyOf("http://[bad"), /isn't a proxy address/);
});
