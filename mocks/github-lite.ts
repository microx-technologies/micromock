import { z } from "zod";
import { customAuth } from "@/src/auth.ts";
import { collection, resource } from "@/src/resource.ts";
import { defineService } from "@/src/service.ts";

const Repo = z.object({
  id: z.string(),
  name: z.string(),
  private: z.boolean(),
});
const Issue = z.object({
  id: z.string(),
  repoId: z.string(),
  title: z.string(),
  open: z.boolean(),
});

const github = defineService({
  name: "github-lite",
  seed: { repos: [{ id: "1", name: "demo", private: false }], issues: [] },
  auth: customAuth((c) => {
    const header = c.req.header("authorization") ?? "";
    return header === "Bearer test-token" || header === "token test-token";
  }),
  resources: {
    repos: resource({
      schema: Repo,
      operations: (r) => ({
        ...r.crud(),
        "POST /repos/:id/star": (c) => {
          const { state } = c.get("mock");
          const repos = collection(state, "repos");
          const repo = repos.get(c.req.param("id") ?? "");
          if (repo === undefined) return c.json({ error: "not_found" }, 404);
          repos.update(repo.id, { starred: true });
          return c.json({ starred: true });
        },
      }),
      sideEffects: {
        "repos.delete": ({ state, entity }) => {
          collection(state, "issues").deleteWhere(
            (i) => i.repoId === entity.id,
          );
        },
      },
    }),
    issues: resource({ schema: Issue }),
  },
  extraRoutes: (app) => {
    app.get("/rate_limit", (c) =>
      c.json({ resources: { core: { remaining: 9999 } } }),
    );
    app.post("/__test/fail-next", async (c) => {
      const { state } = c.get("mock");
      const body = await c.req.json().catch(() => undefined);
      if (
        typeof body !== "object" ||
        body === null ||
        !("n" in body) ||
        !("shape" in body) ||
        typeof body.n !== "number" ||
        typeof body.shape !== "object" ||
        body.shape === null
      ) {
        return c.json(
          {
            error: "validation_failed",
            issues: [{ message: "n and shape required" }],
          },
          400,
        );
      }
      if ("opKey" in body && typeof body.opKey === "string") {
        state.failNext(body.opKey, body.n, body.shape as { status: number });
      } else {
        state.failNext(body.n, body.shape as { status: number });
      }
      return c.json({ ok: true });
    });
  },
});

export default github;

if (import.meta.main) {
  github.start();
}
