// Local-only composition around the unchanged compiled Pages worker. No auth bypass.
import pages from "../../../.profiling/pages-upload/functions.js";
import { resolveBranchForActor } from "../../../functions/api/_lib/branches/lifecycle";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../functions/api/_lib/core/platform/cloudflare/storage";
import { issueAccountSessionToken } from "../../../functions/api/_lib/accounts/session/token";
import { onRequest as middleware } from "../../../functions/api/_middleware";
import { backgroundKind } from "../background";

const account = "revision2-local-fixture";
const digest = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/** Request-local native binding forwarding and content-free operation transcript.
 * Arguments/receivers are forwarded unchanged. Batch statements are unwrapped to
 * their exact native handles, never reconstructed. Native conditional semantics
 * stay in workerd. No keys, SQL, payloads, credentials or exception text are logged. */
function recorder() {
  const ops: { operation: string; args: unknown }[] = [];
  const etags = new Map<string, string>();
  const generations = new Map<string, number>();
  const keys = new Map<string, string>();
  const statements = new WeakMap<object, object>();
  const normalized = (v: any): any => {
    if (typeof v === "number" && v > 1e12) return "clock";
    if (typeof v === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) return "uuid";
      try {
        return normalized(JSON.parse(v));
      } catch {
        return v;
      }
    }
    if (Array.isArray(v)) return v.map(normalized);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, n]) => [k, normalized(n)]),
      );
    return v;
  };
  const encode = async (v: unknown) => digest(JSON.stringify(normalized(v)));
  function r2(bucket: any) {
    return new Proxy(bucket, {
      get(target, key) {
        const fn = Reflect.get(target, key, target);
        if (typeof fn !== "function") return fn;
        return async (...args: any[]) => {
          const row = { operation: `r2.${String(key)}`, args: {} as any };
          ops.push(row);
          const rawKey = JSON.stringify(args[0]);
          if (!keys.has(rawKey)) keys.set(rawKey, `key-${keys.size}`);
          const keyAlias = keys.get(rawKey)!;
          const options = args[key === "put" ? 2 : 1];
          const onlyIf = options?.onlyIf;
          const conditions = onlyIf
            ? Object.fromEntries(
                Object.entries(onlyIf).map(([k, v]) => {
                  if (k === "etagMatches") {
                    if (!etags.has(String(v)))
                      throw Error("Unobserved native conditional ETag");
                    return [k, etags.get(String(v))];
                  }
                  return [k, v];
                }),
              )
            : null;
          const native = Reflect.apply(fn, target, args);
          pending.push(
            Promise.all([
              encode(args[0]),
              options ? encode({ ...options, onlyIf: conditions }) : null,
              key === "put" ? encode(args[1]) : null,
            ]).then(([keyHash, optionsHash, valueHash]) => {
              row.args = {
                keyHash,
                argumentCount: args.length,
                optionsHash,
                conditions,
                valueHash,
              };
            }),
          );
          const result = await native;
          if (result?.etag) {
            if (key === "put")
              generations.set(keyAlias, (generations.get(keyAlias) ?? 0) + 1);
            if (!etags.has(result.etag))
              etags.set(
                result.etag,
                `${keyAlias}:${generations.get(keyAlias) ?? 0}`,
              );
          }
          if (key === "get" && result)
            return new Proxy(result, {
              get(object, property) {
                const member = Reflect.get(object, property, object);
                if (typeof member !== "function") return member;
                return (...parameters: any[]) => {
                  if (
                    ["text", "json", "arrayBuffer"].includes(String(property))
                  )
                    ops.push({
                      operation: "r2.body",
                      args: { method: String(property) },
                    });
                  return Reflect.apply(member, object, parameters);
                };
              },
            });
          return result;
        };
      },
    });
  }
  function sql(db: any): any {
    const proxy = new Proxy(db, {
      get(target, key) {
        const fn = Reflect.get(target, key, target);
        if (typeof fn !== "function") return fn;
        return (...args: any[]) => {
          const index = ops.length;
          ops.push({ operation: `sql.${String(key)}`, args: null });
          // Hashing is deferred, never inserted before the native synchronous prepare/bind.
          const task = encode(
            args.map((a) =>
              typeof a === "object" && a !== null ? "native-handle" : a,
            ),
          ).then((hash) => {
            ops[index].args = { hash, argumentCount: args.length };
          });
          pending.push(task);
          const forwarded =
            key === "batch"
              ? [args[0].map((s: object) => statements.get(s) ?? s)]
              : args;
          const result = Reflect.apply(fn, target, forwarded);
          if (key === "prepare" || key === "bind") return sql(result);
          return result;
        };
      },
    });
    statements.set(proxy, db);
    return proxy;
  }
  const pending: Promise<unknown>[] = [];
  return { r2, sql, ops, pending };
}
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/browser") {
      // Construct the browser-origin request inside workerd; the host getWorker
      // bridge rewrites routing origins. Production origin validation is unchanged.
      return pages.fetch(
        new Request(`${url.origin}/api/telemetry`, {
          method: "POST",
          headers: { Origin: url.origin, "Content-Type": "application/json" },
          body: request.body,
        }),
        env,
        ctx,
      );
    }
    if (url.pathname === "/__fixture/middleware") {
      const failure = new Error("fixture application rejection");
      const next = async () => {
        if (url.searchParams.has("reject")) throw failure;
        const headers = new Headers();
        headers.append(
          "Set-Cookie",
          "fixture-access=one; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
        );
        headers.append(
          "Set-Cookie",
          "fixture-refresh=two; HttpOnly; Expires=Thu, 22 Oct 2037 07:28:00 GMT",
        );
        return new Response("kept", { status: 201, headers });
      };
      try {
        const response = await middleware({
          request,
          env,
          next,
          waitUntil() {
            throw Error("closed context");
          },
        } as Parameters<typeof middleware>[0]);
        if (url.searchParams.has("raw")) return response;
        return Response.json({
          status: response.status,
          cookies: response.headers.getSetCookie(),
          body: await response.text(),
          origin: url.origin,
        });
      } catch (error) {
        if (error !== failure) throw error;
        return Response.json({ applicationRejectionPreserved: true });
      }
    }
    if (url.pathname === "/__fixture/init") {
      const id = url.searchParams.get("id")!;
      if (!/^RevTwo[0-9]{6}$/.test(id))
        return new Response(null, { status: 400 });
      await env.R2_BUCKET.put(
        id,
        JSON.stringify({
          content: "",
          metadata: { ownerAccountId: account, visibility: "private" },
        }),
        { httpMetadata: { contentType: "application/json" } },
      );
      const { branch } = await resolveBranchForActor(
        createCloudflareBlobStore(env.R2_BUCKET),
        id,
        account,
        null,
        undefined,
        createCloudflareSqlStore(env.DB),
      );
      const { token } = await issueAccountSessionToken(account, env);
      return Response.json({ branchId: branch.branchId, token });
    }
    const r = recorder();
    const diagnostic = env.FIXTURE_DIAGNOSTIC === "1";
    const exports: any[] = [];
    const tasks: any[] = [];
    const diagnosticBinding = {
      async fetch(input: Request) {
        const row = {
          endpoint: new URL(input.url).pathname,
          start: Date.now(),
          end: 0,
          status: 0,
          abortedAt: 0,
          outcome: "pending",
        };
        exports.push(row);
        input.signal.addEventListener(
          "abort",
          () => {
            row.abortedAt = Date.now();
          },
          { once: true },
        );
        try {
          const response = await env.TELEMETRY.fetch(input);
          row.status = response.status;
          row.outcome = "resolved";
          return response;
        } catch (error) {
          row.outcome = "rejected";
          throw error;
        } finally {
          row.end = Date.now();
        }
      },
    };
    const bindings = {
      ...env,
      ...(diagnostic ? { TELEMETRY: diagnosticBinding } : {}),
      R2_BUCKET: r.r2(env.R2_BUCKET),
      DB: r.sql(env.DB),
    };
    const background: Promise<unknown>[] = [],
      backgroundMs: number[] = [];
    const runtimeContext = new Proxy(ctx, {
      get(target, key) {
        if (key === "waitUntil")
          return (task: Promise<unknown>) => {
            const start = performance.now();
            const stack = new Error().stack ?? "";
            const row = {
              kind: backgroundKind(stack),
              start: Date.now(),
              end: 0,
              ms: 0,
              outcome: "pending",
              ...(diagnostic ? { stack } : {}),
            };
            tasks.push(row);
            background.push(
              Promise.resolve(task)
                .then(
                  () => {
                    row.outcome = "resolved";
                  },
                  () => {
                    row.outcome = "rejected";
                  },
                )
                .finally(() => {
                  row.end = Date.now();
                  row.ms = performance.now() - start;
                  backgroundMs.push(row.ms);
                }),
            );
            ctx.waitUntil(task);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const at = performance.now();
    const response = await pages.fetch(request, bindings, runtimeContext);
    const canonicalMs = performance.now() - at;
    const canonicalOps = r.ops.slice();
    ctx.waitUntil(
      Promise.allSettled([...background, ...r.pending]).then(async () => {
        const responseAudit = await env.FIXTURE_AUDIT.fetch(
          new Request("https://local-audit.invalid/", {
            method: "POST",
            body: JSON.stringify({
              traceId: request.headers.get("traceparent")?.split("-")[1],
              canonicalMs,
              backgroundMs,
              tasks,
              ...(diagnostic ? { exports } : {}),
              ops: canonicalOps,
            }),
          }),
        );
        if (responseAudit.body) await responseAudit.body.cancel();
      }),
    );
    return response;
  },
};
