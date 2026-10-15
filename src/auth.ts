import type { Context, MiddlewareHandler, Next } from "hono";
import { basicAuth as honoBasicAuth } from "hono/basic-auth";
import { bearerAuth as honoBearerAuth } from "hono/bearer-auth";
import {
  DEFAULT_API_KEY_HEADER,
  DEFAULT_API_KEY_QUERY,
  ERR_UNAUTHORIZED,
} from "@/src/constants.ts";

function unauthorized(c: Context): Response {
  return c.json({ error: ERR_UNAUTHORIZED }, 401);
}

export function bearerAuth({
  tokens,
}: {
  tokens: string[];
}): MiddlewareHandler {
  if (tokens.length === 0) {
    throw new Error("micromock: bearerAuth requires non-empty tokens");
  }
  const inner = honoBearerAuth({
    verifyToken: (token) => tokens.includes(token),
    invalidToken: { message: { error: ERR_UNAUTHORIZED } },
    noAuthenticationHeader: { message: { error: ERR_UNAUTHORIZED } },
  });
  return async (c, next) => inner(c, next);
}

export type BasicAuthOptions =
  | { username: string; password: string }
  | { pairs: Array<{ username: string; password: string }> };

export function basicAuth(opts: BasicAuthOptions): MiddlewareHandler {
  if ("pairs" in opts) {
    if (opts.pairs.length === 0) {
      throw new Error("micromock: basicAuth requires non-empty pairs");
    }
    return honoBasicAuth({
      verifyUser: (username, password) =>
        opts.pairs.some(
          (p) => p.username === username && p.password === password,
        ),
    });
  }
  if (opts.username.length === 0 || opts.password.length === 0) {
    throw new Error(
      "micromock: basicAuth requires non-empty username and password",
    );
  }
  return honoBasicAuth({ username: opts.username, password: opts.password });
}

export function apiKeyAuth({
  keys,
  header = DEFAULT_API_KEY_HEADER,
  query = DEFAULT_API_KEY_QUERY,
}: {
  keys: string[];
  header?: string;
  query?: string;
}): MiddlewareHandler {
  if (keys.length === 0) {
    throw new Error("micromock: apiKeyAuth requires non-empty keys");
  }
  const headerName = header.toLowerCase();
  return async (c: Context, next: Next) => {
    const byHeader = c.req.header(headerName);
    const byQuery = query.length > 0 ? c.req.query(query) : undefined;
    if (
      (byHeader !== undefined && keys.includes(byHeader)) ||
      (byQuery !== undefined && keys.includes(byQuery))
    ) {
      await next();
      return;
    }
    return unauthorized(c);
  };
}

export function customAuth(
  fn: (c: Context) => boolean | Response | Promise<boolean | Response>,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const verdict = await fn(c);
    if (typeof verdict === "boolean") {
      if (verdict) {
        await next();
        return;
      }
      return unauthorized(c);
    }
    if (verdict instanceof Response) return verdict;
    throw new Error("micromock: customAuth must return boolean or Response");
  };
}
