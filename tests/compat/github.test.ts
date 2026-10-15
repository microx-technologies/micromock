import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import github from "@mocks/github-lite.ts";
import { Octokit } from "octokit";

let baseUrl = "";
let stop = () => {};

beforeAll(() => {
  const srv = github.start(0);
  baseUrl = srv.url;
  stop = () => srv.close();
});

afterAll(() => {
  stop();
  github.reset();
});

describe("github-lite octokit compat", () => {
  test("create, get, star, cascade delete, rate_limit", async () => {
    const octokit = new Octokit({ baseUrl, auth: "test-token" });
    const created = await octokit.request("POST /repos", {
      name: "x",
      private: false,
    });
    expect(created.status).toBe(201);
    const id = (created.data as { id: string }).id;
    expect(typeof id).toBe("string");

    const got = await octokit.request("GET /repos/{id}", { id });
    expect((got.data as { name: string }).name).toBe("x");

    const star = await octokit.request("POST /repos/{id}/star", { id });
    expect(star.data).toEqual({ starred: true });

    const issue = await octokit.request("POST /issues", {
      repoId: id,
      title: "bug",
      open: true,
    });
    expect(issue.status).toBe(201);

    await octokit.request("DELETE /repos/{id}", { id });
    const issues = await octokit.request("GET /issues");
    expect(issues.data).toEqual([]);

    const rate = await octokit.request("GET /rate_limit");
    expect(
      (rate.data as { resources: { core: { remaining: number } } }).resources
        .core.remaining,
    ).toBe(9999);
  });

  test("fail-next drives an SDK error path", async () => {
    const octokit = new Octokit({
      baseUrl,
      auth: "test-token",
      retry: { enabled: false },
    });
    await fetch(`${baseUrl}/__test/fail-next`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        opKey: "GET /repos",
        n: 1,
        shape: { status: 500, body: { error: "boom" } },
      }),
    });
    const err = (await octokit
      .request("GET /repos")
      .catch((e: unknown) => e)) as { status?: number };
    expect(err.status).toBe(500);
  });
});
