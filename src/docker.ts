import { createHash, randomInt } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUN_VERSION = Bun.version;

async function fileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

export async function buildImage(
  serviceFile: string,
): Promise<{ tag: string; cached: boolean }> {
  const root = dirname(dirname(fileURLToPath(__filename)));
  const absService = isAbsolute(serviceFile)
    ? serviceFile
    : resolve(process.cwd(), serviceFile);
  const file = Bun.file(absService);
  if (!(await file.exists())) {
    throw new Error(`micromock: service file not found: ${serviceFile}`);
  }
  const hash = createHash("sha256");
  hash.update(await fileBytes(absService));
  try {
    hash.update(await fileBytes(join(root, "dist", "index.js")));
  } catch {
    const glob = new Bun.Glob("src/**/*.ts");
    const files = [...glob.scanSync({ cwd: root, absolute: true })].sort();
    for (const path of files) hash.update(await fileBytes(path));
  }
  hash.update(await fileBytes(join(root, "Dockerfile.tmpl")));
  hash.update(BUN_VERSION);
  const short = absService.split("/").pop()?.replace(/\.ts$/, "") ?? "service";
  const tag = `micromock-${short}:${hash.digest("hex").slice(0, 8)}`;

  const marker = join(tmpdir(), "micromock", "cache", tag);
  if (await Bun.file(marker).exists()) {
    return { tag, cached: true };
  }

  const inspect = Bun.spawnSync(["docker", "image", "inspect", tag]);
  if (inspect.exitCode === 0) {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, tag, { flag: "w" }).catch(() => undefined);
    return { tag, cached: true };
  }

  const ctx = await mkdtemp(join(tmpdir(), "micromock-"));
  try {
    await writeFile(
      join(ctx, "entry.ts"),
      `import svc from ${JSON.stringify(absService)};\n` +
        `const raw = process.env["MICROMOCK_SEED"];\n` +
        `if (raw !== undefined) svc.withSeed(JSON.parse(raw));\n` +
        `svc.start();\n`,
    );
    const build = Bun.spawnSync(
      [
        "bun",
        "build",
        join(ctx, "entry.ts"),
        "--target=bun",
        `--outfile=${join(ctx, "dist", "service.js")}`,
      ],
      { cwd: root },
    );
    if (build.exitCode !== 0) {
      throw new Error(`micromock: bun build failed:\n${build.stderr}`);
    }
    const dockerfile = await fileBytes(join(root, "Dockerfile.tmpl"));
    await writeFile(join(ctx, "Dockerfile"), dockerfile);
    const result = Bun.spawnSync(["docker", "build", "-t", tag, ctx]);
    if (result.exitCode !== 0) {
      throw new Error(`micromock: docker build failed:\n${result.stderr}`);
    }
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, tag, { flag: "w" }).catch(() => undefined);
    return { tag, cached: false };
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
}

export function ephemeralPort(): number {
  return 32000 + randomInt(1000);
}
