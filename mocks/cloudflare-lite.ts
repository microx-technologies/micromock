import { z } from "zod";
import { apiKeyAuth } from "@/auth.ts";
import { collection, resource } from "@/resource.ts";
import { defineService } from "@/service.ts";

const Zone = z.object({ id: z.string(), name: z.string(), status: z.string() });
const DnsRecord = z.object({
  id: z.string(),
  zone_id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
});

const envelope = (result: unknown) => ({
  result,
  success: true,
  errors: [],
  messages: [],
});

const beyondFirstPage = (
  query: (name: string) => string | undefined,
): boolean => (query("page") ?? "1") !== "1";

const cloudflare = defineService({
  name: "cloudflare-lite",
  seed: {
    zones: [{ id: "zone1", name: "example.com", status: "active" }],
    dns_records: [
      {
        id: "rec1",
        zone_id: "zone1",
        type: "A",
        name: "example.com",
        content: "1.2.3.4",
      },
    ],
  },
  auth: apiKeyAuth({ keys: ["test-key"], header: "X-Auth-Key" }),
  resources: {
    zones: resource({
      schema: Zone,
      operations: (r) => ({
        "GET /zones": (c) => {
          const zones = collection(c.get("mock").state, "zones");
          const rows = beyondFirstPage((n) => c.req.query(n))
            ? []
            : zones.list();
          return c.json({
            ...envelope(rows),
            result_info: { page: 1, count: rows.length },
          });
        },
        "GET /zones/:id": (c) => {
          const zone = collection(c.get("mock").state, "zones").get(
            c.req.param("id") ?? "",
          );
          if (zone === undefined) {
            return c.json(
              { result: null, success: false, errors: [{ code: 7003 }] },
              404,
            );
          }
          return c.json(envelope(zone));
        },
        "POST /zones": async (c) => {
          const { state } = c.get("mock");
          const body = await c.req.json();
          const zone = collection(state, "zones").create({
            name: body.name,
            status: "pending",
          });
          return c.json(envelope(zone), 201);
        },
        "DELETE /zones/:id": (c) => {
          const { state } = c.get("mock");
          const id = c.req.param("id") ?? "";
          const zones = collection(state, "zones");
          if (zones.get(id) === undefined) {
            return c.json(
              { result: null, success: false, errors: [{ code: 7003 }] },
              404,
            );
          }
          zones.delete(id);
          collection(state, "dns_records").deleteWhere(
            (rec) => rec.zone_id === id,
          );
          return c.json(envelope({ id }));
        },
        ...Object.fromEntries(
          Object.entries(r.crud()).filter(([k]) => k.startsWith("PATCH")),
        ),
      }),
    }),
    dns_records: resource({
      schema: DnsRecord,
      operations: (r) => ({
        ...r.crud(),
        "GET /zones/:id/dns_records": (c) => {
          const { state } = c.get("mock");
          const all = collection(state, "dns_records")
            .list()
            .filter((rec) => rec.zone_id === c.req.param("id"));
          const rows = beyondFirstPage((n) => c.req.query(n)) ? [] : all;
          return c.json({
            ...envelope(rows),
            result_info: { page: 1, count: rows.length },
          });
        },
        "POST /zones/:id/dns_records": async (c) => {
          const { state } = c.get("mock");
          const body = await c.req.json();
          const rec = collection(state, "dns_records").create({
            zone_id: c.req.param("id"),
            ...body,
          });
          return c.json(envelope(rec), 201);
        },
      }),
    }),
  },
});

export default cloudflare;

if (import.meta.main) {
  cloudflare.start();
}
