import { spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { build as esbuild } from "esbuild";

async function fileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectTs(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectTs(root, full)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

export async function buildImage(
  serviceFile: string,
): Promise<{ tag: string; cached: boolean }> {
  const root = dirname(dirname(__filename));
  const absService = isAbsolute(serviceFile)
    ? serviceFile
    : resolve(process.cwd(), serviceFile);
  if (!(await exists(absService))) {
    throw new Error(`micromock: service file not found: ${serviceFile}`);
  }
  const hash = createHash("sha256");
  hash.update(await fileBytes(absService));
  try {
    hash.update(await fileBytes(join(root, "dist", "index.js")));
  } catch {
    const files = (await collectTs(root, join(root, "src"))).sort();
    for (const path of files) hash.update(await fileBytes(path));
  }
  hash.update(await fileBytes(join(root, "Dockerfile.tmpl")));
  hash.update(process.version);
  const short = absService.split("/").pop()?.replace(/\.ts$/, "") ?? "service";
  const tag = `micromock-${short}:${hash.digest("hex").slice(0, 8)}`;

  const marker = join(tmpdir(), "micromock", "cache", tag);
  if (await exists(marker)) {
    return { tag, cached: true };
  }

  const inspect = spawnSync("docker", ["image", "inspect", tag]);
  if (inspect.status === 0) {
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
    try {
      await esbuild({
        entryPoints: [join(ctx, "entry.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: join(ctx, "dist", "service.cjs"),
        banner: {
          js: "var import_meta_url = 'file:///micromock-bundled-service';",
        },
        define: { "import.meta.url": "import_meta_url" },
        logLevel: "warning",
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`micromock: esbuild bundle failed:\n${detail}`);
    }
    const dockerfile = await fileBytes(join(root, "Dockerfile.tmpl"));
    await writeFile(join(ctx, "Dockerfile"), dockerfile);
    const result = spawnSync("docker", ["build", "-t", tag, ctx]);
    if (result.status !== 0) {
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
