import "server-only";
import { randomUUID } from "node:crypto";
import { endpoints } from "./endpoints";
import { openApiDocument } from "./openapi";
import { credentials, checkOrigin, jsonBody, rateLimit, clientKey, type ApiContext } from "./http";
import { AppError } from "../errors";
import { one } from "../data/core";
import { sharedCapacity, type Capacity } from "../concurrency";
import { backendConfig } from "../config";
import { observeRequest } from "../observability";

let apiCapacity: Capacity | undefined, uploads: Capacity | undefined;
export function requestCapacity(): Capacity { return apiCapacity ??= sharedCapacity("api", backendConfig().apiConcurrency); }
function uploadCapacity(): Capacity { return uploads ??= sharedCapacity("uploads", backendConfig().uploadConcurrency); }
const routes = endpoints.map(endpoint => ({
  endpoint,
  names: [...endpoint.path.matchAll(/:([A-Za-z]+)/g)].map(m => m[1]),
  pattern: new RegExp(`^${endpoint.path.split("/").map(part => part.startsWith(":") ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}$`),
}));
let contract: string | undefined;


const expectedErrors = new Set([
  "Username must be 3–15 letters, numbers, or underscores", "Display name must be 1–50 characters", "Password must be at least 8 characters", "Password must be at most 1024 characters", "That username isn't available",
  "Posts can be at most 280 characters", "Write something or add an image", "Invalid images", "You cannot follow yourself", "Token name must be 1–40 characters", "Expiry must be 1 to 3650 days", "You can have at most 10 agent tokens. Revoke one first", "Elytra set this label on your account, so you can't change it",
]);
const missingErrors = new Set(["Post not found", "User not found", "The post you are replying to no longer exists", "The quoted post no longer exists", "This post no longer exists", "Token not found"]);
/** Framework-independent dispatcher, also exercised directly by the API integration suite. */
export async function handleApi(request: Request): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": randomUUID() });
  let response: Response;
  const started = performance.now();
  let route = "unmatched", release: (() => void) | undefined, releaseUpload: (() => void) | undefined;
  try {
    const url = new URL(request.url);
    if (!/^\/api\/v1(?:\/|$)/.test(url.pathname)) throw new AppError(404, "not_found", "API endpoint not found");
    const path = url.pathname.replace(/^\/api\/v1/, "").replace(/\/$/, "") || "/";
    if (path.length > 2000) throw new AppError(400, "validation_error", "Path is too long");
    const matches = routes.flatMap(({ endpoint, pattern, names }) => {
      const match = pattern.exec(path);
      return match ? [{ endpoint, names, values: match.slice(1) }] : [];
    });
    const special = ["/", "/openapi.json", "/health", "/health/live"].includes(path);
    if (!matches.length && !special) throw new AppError(404, "not_found", "API endpoint not found");
    const allow = [...new Set([...(special ? ["GET"] : matches.map(m => m.endpoint.method)), ...(special || matches.some(m => m.endpoint.method === "GET") ? ["HEAD"] : []), "OPTIONS"])].join(", ");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...Object.fromEntries(headers), Allow: allow } });
    const method = request.method === "HEAD" ? "GET" : request.method;
    const selected = matches.find(m => m.endpoint.method === method);
    if ((!selected && !special) || (special && method !== "GET")) { headers.set("Allow", allow); throw new AppError(405, "method_not_allowed", "Method not allowed for this endpoint"); }
    route = selected?.endpoint.path ?? path;
    if (path === "/health" || path === "/health/live") {
      if (path === "/health") one("SELECT 1");
      return request.method === "HEAD" ? new Response(null, { headers }) : Response.json({ data: { status: "ok", version: "1" } }, { headers });
    }
    release = await requestCapacity().acquire();
    if (path === "/media" && method === "POST") releaseUpload = await uploadCapacity().acquire();
    const auth = credentials(request);
    checkOrigin(request, auth.bearer);
    const viewer = auth.viewer;
    if (selected?.endpoint.auth && !viewer) throw new AppError(401, "unauthorized", "Authentication required");
    const limit = method === "GET" ? 600 : viewer ? 120 : 60;
    const rate = rateLimit(`api:${viewer?.id ?? `anonymous:${clientKey(request)}`}:${method === "GET" ? "read" : "write"}`, limit, 60000);
    headers.set("RateLimit-Limit", String(limit)); headers.set("RateLimit-Remaining", String(rate.remaining)); headers.set("RateLimit-Reset", String(rate.reset));
    if (special) {
      response = path === "/openapi.json" ? new Response(contract ??= JSON.stringify(openApiDocument()), { headers: { "Content-Type": "application/json" } })
        : Response.json({ data: { name: "Elytra API", version: "1", openapi: "/api/v1/openapi.json", endpoints: endpoints.map(({ method, path, summary, auth }) => ({ method, path: `/api/v1${path}`, summary, authenticationRequired: auth })) } });
    } else {
      const { endpoint, values, names } = selected!;
      const params: Record<string, string> = {};
      names.forEach((name, i) => {
        let value: string;
        try { value = decodeURIComponent(values[i]); } catch { throw new AppError(400, "validation_error", "Malformed path parameter"); }
        if (!(name === "username" ? /^[A-Za-z0-9_]{1,15}$/ : /^[A-Za-z0-9_-]{1,100}$/).test(value)) throw new AppError(400, "validation_error", `Invalid ${name}`);
        params[name] = value;
      });
      const allowedQuery = new Set([...(endpoint.paged ? ["cursor", "limit"] : []), ...Object.keys(endpoint.query ?? {})]);
      for (const [name] of url.searchParams) if (!allowedQuery.has(name) || url.searchParams.getAll(name).length > 1) throw new AppError(400, "validation_error", `Unknown or repeated query parameter: ${name}`);
      const ctx: ApiContext = { request, url, params, viewer, token: auth.token, headers, body: endpoint.body ? await jsonBody(request, endpoint.body, endpoint.bodyLimit) : {} };
      response = await endpoint.handler(ctx);
    }
  } catch (error) {
    let failure = error instanceof AppError ? error : error instanceof Error && expectedErrors.has(error.message) ? new AppError(400, "validation_error", error.message)
      : error instanceof Error && missingErrors.has(error.message) ? new AppError(404, "not_found", error.message) : null;
    const sqliteCode = (error as { errcode?: number } | null)?.errcode;
    if (!failure && (sqliteCode === 5 || sqliteCode === 6 || (typeof sqliteCode === "number" && [5, 6].includes(sqliteCode & 255)))) failure = new AppError(503, "database_busy", "Database is busy. Try again shortly.", { retryAfter: 1 });
    if (!failure && error instanceof Error && /UNIQUE constraint failed: users.username_lower/.test(error.message)) failure = new AppError(409, "username_taken", "That username is already taken");
    if (!failure) {
      console.error(`API error ${headers.get("X-Request-Id")}`, error);
      failure = new AppError(500, "internal_error", "Something went wrong");
    }
    if (failure.status === 401) headers.set("WWW-Authenticate", 'Bearer realm="elytra"');
    if (failure.status === 429 || failure.status === 503) headers.set("Retry-After", String((failure.details as { retryAfter?: number } | undefined)?.retryAfter ?? 1));
    response = Response.json({ error: { code: failure.code, message: failure.message, ...(failure.details !== undefined ? { details: failure.details } : {}) } }, { status: failure.status });
  } finally {
    releaseUpload?.();
    release?.();
  }
  headers.set("Server-Timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
  observeRequest({ requestId: headers.get("X-Request-Id")!, method: request.method, route, status: response.status, durationMs: Math.round((performance.now() - started) * 10) / 10 });
  for (const [name, value] of headers) response.headers.set(name, value);
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
