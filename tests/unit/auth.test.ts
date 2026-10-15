import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  apiKeyAuth,
  basicAuth,
  bearerAuth,
  customAuth,
  defineService,
  resource,
} from "@/index.ts";

const Item = z.object({ id: z.string() });

const build = (auth: Parameters<typeof defineService>[0]["auth"]) =>
  defineService({
    name: "t",
    auth,
    resources: { items: resource({ schema: Item }) },
  });

describe("auth presets", () => {
  test("bearer accept and reject", async () => {
    const svc = build(bearerAuth({ tokens: ["t"] }));
    expect(
      (
        await svc.app.request("/items", {
          headers: { authorization: "Bearer t" },
        })
      ).status,
    ).toBe(200);
    expect((await svc.app.request("/items")).status).toBe(401);
    expect(
      (
        await svc.app.request("/items", {
          headers: { authorization: "Bearer z" },
        })
      ).status,
    ).toBe(401);
    const body = await (await svc.app.request("/items")).json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  test("bearer empty tokens throws", () => {
    expect(() => bearerAuth({ tokens: [] })).toThrow(/non-empty tokens/);
  });

  test("basic single and pairs", async () => {
    const svc = build(basicAuth({ username: "u", password: "p" }));
    const good = `Basic ${Buffer.from("u:p").toString("base64")}`;
    expect(
      (await svc.app.request("/items", { headers: { authorization: good } }))
        .status,
    ).toBe(200);
    expect((await svc.app.request("/items")).status).toBe(401);

    const pairs = build(
      basicAuth({ pairs: [{ username: "a", password: "b" }] }),
    );
    const g2 = `Basic ${Buffer.from("a:b").toString("base64")}`;
    expect(
      (await pairs.app.request("/items", { headers: { authorization: g2 } }))
        .status,
    ).toBe(200);
    expect(() => basicAuth({ pairs: [] })).toThrow(/non-empty pairs/);
  });

  test("apiKey header and query", async () => {
    const svc = build(apiKeyAuth({ keys: ["k"] }));
    expect(
      (await svc.app.request("/items", { headers: { "x-api-key": "k" } }))
        .status,
    ).toBe(200);
    expect((await svc.app.request("/items?api_key=k")).status).toBe(200);
    expect((await svc.app.request("/items")).status).toBe(401);
    expect(() => apiKeyAuth({ keys: [] })).toThrow(/non-empty keys/);
  });

  test("customAuth boolean, response passthrough, invalid return", async () => {
    const allow = build(customAuth(() => true));
    expect((await allow.app.request("/items")).status).toBe(200);

    const deny = build(customAuth(() => false));
    expect((await deny.app.request("/items")).status).toBe(401);

    const shaped = build(
      customAuth(
        () =>
          new Response(JSON.stringify({ error: "forbidden_zone" }), {
            status: 403,
          }),
      ),
    );
    const res = await shaped.app.request("/items");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_zone" });

    const broken = build(customAuth(() => "yes" as never));
    expect((await broken.app.request("/items")).status).toBe(500);
  });

  test("framework routes bypass auth", async () => {
    const svc = build(bearerAuth({ tokens: ["t"] }));
    expect((await svc.app.request("/__micromock/health")).status).toBe(200);
    expect(
      (await svc.app.request("/__micromock/reset", { method: "POST" })).status,
    ).toBe(200);
  });
});
