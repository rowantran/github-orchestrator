import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureFree, parseServeConfig } from "../orchestrator/tailscale.js";

const forward = (port = "8080", handler: unknown = { TCPForward: "127.0.0.1:4321" }) => ({ TCP: { [port]: handler } });
const web = (handler: unknown = { Proxy: "http://127.0.0.1:4321" }, mount = "/", host = "node:8080", tcp: unknown = { HTTP: true }) => ({
  TCP: { 8080: tcp }, Web: { [host]: { Handlers: { [mount]: handler } } },
});

test("Serve status fails closed at every schema level, including unrelated ports", () => {
  const malformed: unknown[] = [
    [], true, "", { tcp: {} }, { Unknown: {} }, { TCP: null }, { Web: [] },
    { Foreground: null }, { Foreground: { session: [] } }, { Foreground: { session: {} } },
    { Foreground: { "": forward() } }, { Foreground: { session: { ...forward(), Foreground: { nested: forward() } } } },
    { Foreground: { session: { ...forward(), Services: { "svc:test": {} } } } },
    ...["0", "65536", "08080", "8080\n"].map(key => forward(key)),
    ...[null, [], {}, { HTTP: true }, { TCPForward: 123 }, { TCPForward: "host:1", Unknown: true },
      { TCPForward: "host:1", ProxyProtocol: 3 }, { TCPForward: "host:1", ProxyProtocol: "1" }].map(handler => forward("9000", handler)),
    web({ Proxy: "host:1" }, "/", "node:8080", { HTTP: true, HTTPS: true }),
    web({ Proxy: "host:1" }, "/", "node:8080", { HTTP: true, TerminateTLS: "node" }),
    web({ Proxy: "host:1" }, "/", "node:8080", { HTTP: "true" }),
    { Web: { "node:8080": { Handlers: { "/": { Text: "orphan" } } } } },
    { TCP: { 8080: { HTTP: true } }, Web: { "node:8080": { Handlers: {} } } },
    { TCP: { 8080: { HTTP: true } }, Web: { "node:8080": { Handlers: {}, Unknown: true } } },
    ...[null, [], {}, { Proxy: 123 }, { Proxy: "host:1", Text: "conflict" }, { Unknown: "handler" },
      { Text: "hello", AcceptAppCaps: [""] }, { Text: "hello", AcceptAppCaps: [1] },
      { Text: "hello", AcceptAppCaps: "cap" }].map(handler => web(handler)),
    web({ Text: "hello" }, "relative"), web({ Text: "hello" }, "/", "node\n:8080"),
    ...["node:0", "node:nope", "node:8080\n", "node\n:8080"].map(key => ({ AllowFunnel: { [key]: true } })),
    { AllowFunnel: { "node:8080": "true" } },
    { Services: { invalid: {} } }, { Services: { "svc:test": [] } },
    { Services: { "svc:test": { Tun: "yes" } } }, { Services: { "svc:test": { ...forward(), Tun: true } } },
    { Services: { "svc:test": { Unknown: true } } },
  ];
  for (const value of malformed) assert.throws(() => parseServeConfig(value), Error, JSON.stringify(value));
});

test("known empty, forwarding, web, capability and virtual-service shapes remain supported", () => {
  for (const value of [
    null, {}, { TCP: {}, Web: {}, Foreground: {}, AllowFunnel: {}, Services: {} },
    forward(), forward("8443", { TCPForward: "host:1", TerminateTLS: "node", ProxyProtocol: 2 }),
    ...[{ Proxy: "http://127.0.0.1:1" }, { Path: "/tmp" }, { Text: "hello" }, { Redirect: "https://example.test" },
      { Text: "hello", AcceptAppCaps: ["example.test/cap"] }].map(handler => web(handler)),
    web({ Text: "hello" }, "/", "node:8080", { HTTPS: true }),
    { Foreground: { existing: forward("9000") } },
    { Services: { "svc:test": { Tun: true }, "svc:proxy": forward() } },
  ]) assert.doesNotThrow(() => parseServeConfig(value), JSON.stringify(value));
});

test("persistent and foreground ports and dormant Funnel claims block only the selected node port", () => {
  for (const value of [
    forward(), web(), { Foreground: { existing: forward() } },
    { AllowFunnel: { "other.example.ts.net:8080": true } },
    { Foreground: { existing: { ...forward("9000"), AllowFunnel: { "other.example.ts.net:8080": true } } } },
  ]) {
    const config = parseServeConfig(value);
    assert.throws(() => ensureFree(config, 8080), /already in use|Funnel/, JSON.stringify(value));
    assert.doesNotThrow(() => ensureFree(config, 8081));
  }
  for (const value of [
    { AllowFunnel: { "node:8080": false } },
    { Services: { "svc:test": forward() } }, // Virtual services do not occupy node ports.
  ]) assert.doesNotThrow(() => ensureFree(parseServeConfig(value), 8080));
});
