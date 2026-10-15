import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { HEALTH_PATH, RESET_PATH } from "@/src/constants.ts";
import { buildImage, ephemeralPort } from "@/src/docker.ts";
import type { StartedMock } from "@/src/types.ts";

export class MicromockContainer {
  private seedPatch: Record<string, unknown[]> | undefined;

  constructor(readonly serviceFile: string) {
    if (!serviceFile.endsWith(".ts")) {
      throw new Error(`micromock: service file must end .ts: ${serviceFile}`);
    }
  }

  withSeed(patch: Record<string, unknown[]>): this {
    this.seedPatch = patch;
    return this;
  }

  async start(): Promise<StartedMock> {
    const { tag } = await buildImage(this.serviceFile);
    const port = ephemeralPort();
    const container: StartedTestContainer = await new GenericContainer(tag)
      .withExposedPorts(port)
      .withEnvironment({
        PORT: String(port),
        MICROMOCK_SEED: JSON.stringify(this.seedPatch ?? {}),
      })
      .withWaitStrategy(Wait.forHttp(HEALTH_PATH, port))
      .withStartupTimeout(30_000)
      .start();
    const base = `http://${container.getHost()}:${container.getMappedPort(port)}`;
    return {
      baseUrl: () => base,
      wsUrl: (path = "/") => base.replace(/^http/, "ws") + path,
      reset: async () => {
        const res = await fetch(`${base}${RESET_PATH}`, { method: "POST" });
        if (!res.ok)
          throw new Error(`micromock: reset failed with ${res.status}`);
      },
      stop: async () => {
        await container.stop();
      },
    };
  }
}
