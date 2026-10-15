import cf from "@mocks/cloudflare-lite.ts";
import Cloudflare from "cloudflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let baseURL = "";
let stop = () => {};

beforeAll(() => {
  const srv = cf.start(0);
  baseURL = srv.url;
  stop = () => srv.close();
});

afterAll(() => {
  stop();
  cf.reset();
});

describe("cloudflare-lite SDK compat", () => {
  test("zones list/get plus nested dns records", async () => {
    const client = new Cloudflare({
      baseURL,
      apiKey: "test-key",
      apiEmail: "a@b.c",
    });

    const zones = [];
    for await (const z of client.zones.list()) zones.push(z);
    expect(zones).toHaveLength(1);
    expect(zones[0]?.name).toBe("example.com");

    const one = await client.zones.get({ zone_id: "zone1" });
    expect(one.id).toBe("zone1");

    const recs = [];
    for await (const r of client.dns.records.list({ zone_id: "zone1" }))
      recs.push(r);
    const created = await client.dns.records.create({
      zone_id: "zone1",
      type: "AAAA",
      name: "x",
      content: "::1",
      ttl: 1,
    });
    expect(created.type).toBe("AAAA");

    const recsAfter = [];
    for await (const r of client.dns.records.list({ zone_id: "zone1" }))
      recsAfter.push(r);
    expect(recsAfter).toHaveLength(2);
  });
});
