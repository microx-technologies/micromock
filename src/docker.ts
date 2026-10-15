import { createHash, randomInt } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN_VERSION = Bun.version;

async function fileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

export async function buildImage(
  serviceFile: string,
): Promise<{ tag: string; cached: boolean }> {
  const file = Bun.file(serviceFile);
  if (!(await file.exists())) {
    throw new Error(`micromock: service file not found: ${serviceFile}`);
  }
  const serviceBytes = await fileBytes(serviceFile);
  const glob = new Bun.Glob("src/**/*.ts");
  const srcFiles = [
    ...glob.scanSync({ cwd: process.cwd(), absolute: true }),
  ].sort();
  const hash = createHash("sha256");
  hash.update(serviceBytes);
  for (const path of srcFiles) hash.update(await fileBytes(path));
  hash.update(await fileBytes(join(process.cwd(), "Dockerfile.tmpl")));
  hash.update(BUN_VERSION);
  const short = serviceFile.split("/").pop()?.replace(/\.ts$/, "") ?? "service";
  const tag = `micromock-${short}:${hash.digest("hex").slice(0, 8)}`;

  const marker = Bun.file(join(process.cwd(), ".micromock", "cache", tag));
  if (await marker.exists()) {
    return { tag, cached: true };
  }

  const inspect = Bun.spawnSync(["docker", "image", "inspect", tag]);
  if (inspect.exitCode === 0) {
    await writeFile(marker.name as string, tag, { flag: "w" }).catch(
      () => undefined,
    );
    return { tag, cached: true };
  }

  const ctx = await mkdtemp(join(tmpdir(), "micromock-"));
  try {
    await writeFile(
      join(ctx, "entry.ts"),
      `import svc from ${JSON.stringify(serviceFile)};\n` +
        `const raw = process.env["MICROMOCK_SEED"];\n` +
        `if (raw !== undefined) svc.withSeed(JSON.parse(raw));\n` +
        `svc.start();\n`,
    );
    const build = Bun.spawnSync([
      "bun",
      "build",
      join(ctx, "entry.ts"),
      "--target=bun",
      `--outfile=${join(ctx, "dist", "service.js")}`,
    ]);
    if (build.exitCode !== 0) {
      throw new Error(`micromock: bun build failed:\n${build.stderr}`);
    }
    const dockerfile = await fileBytes(join(process.cwd(), "Dockerfile.tmpl"));
    await writeFile(join(ctx, "Dockerfile"), dockerfile);
    const result = Bun.spawnSync(["docker", "build", "-t", tag, ctx]);
    if (result.exitCode !== 0) {
      throw new Error(`micromock: docker build failed:\n${result.stderr}`);
    }
    await writeFile(marker.name as string, tag, { flag: "w" }).catch(
      () => undefined,
    );
    return { tag, cached: false };
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

export function ephemeralPort(): number {
  return 32000 + randomInt(1000);
}
