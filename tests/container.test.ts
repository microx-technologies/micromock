import { describe, expect, test } from "bun:test";
import { MicromockContainer } from "@/src/index.ts";

describe("MicromockContainer", () => {
  test("builds, seeds, isolates via reset", async () => {
    const mock = await new MicromockContainer(
      `${process.cwd()}/mocks/github-lite.ts`,
    )
      .withSeed({ repos: [{ id: "s1", name: "seeded", private: true }] })
      .start();
    try {
      const headers = { authorization: "Bearer test-token" };
      const seeded = (await (
        await fetch(`${mock.baseUrl()}/repos`, { headers })
      ).json()) as Array<{ id: string }>;
      expect(seeded).toHaveLength(1);
      expect(seeded[0]?.id).toBe("s1");

      await fetch(`${mock.baseUrl()}/repos`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "tmp", private: false }),
      });
      await mock.reset();
      const after = (await (
        await fetch(`${mock.baseUrl()}/repos`, { headers })
      ).json()) as Array<unknown>;
      expect(after).toHaveLength(1);
    } finally {
      await mock.stop();
    }
  }, 120_000);
});
