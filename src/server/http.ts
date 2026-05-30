/** HTTP method token accepted by the platform-neutral Nulldown server facade. */
export type NulldownServerMethod =
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT"
  | "*";

/** Route parameters decoded from a path pattern like `/api/diff/:id`. */
export type NulldownServerRouteParams = Record<string, string>;

/** Request context passed to a matched Nulldown server route handler. */
export interface NulldownServerRouteContext {
  /** Original Web request received by the server facade. */
  request: Request;
  /** Parsed URL for the current request. */
  url: URL;
  /** Decoded route parameters keyed by parameter name. */
  params: NulldownServerRouteParams;
}

/** Handler for one platform-neutral Web `Request` route. */
export type NulldownServerRouteHandler = (
  context: NulldownServerRouteContext,
) => Response | Promise<Response>;

/** One route registered with the platform-neutral Nulldown server facade. */
export interface NulldownServerRoute {
  /** HTTP method handled by this route, or `*` for all methods. */
  method: NulldownServerMethod;
  /** Absolute path pattern. Dynamic segments use `:name`, for example `/api/get/:id`. */
  path: string;
  /** Route implementation. */
  handler: NulldownServerRouteHandler;
}

/** Options used to compose the platform-neutral Nulldown server facade. */
export interface CreateNulldownServerOptions {
  /** Routes exposed by this server instance. */
  routes: NulldownServerRoute[];
  /** Optional error hook for logging or custom failure responses. */
  onError?: (error: unknown, context: NulldownServerRouteContext) => Response | void | Promise<Response | void>;
  /** Optional fallback when no route path matches. Defaults to a JSON 404. */
  notFound?: (request: Request) => Response | Promise<Response>;
}

/** Platform-neutral Nulldown server facade with a Web `fetch` boundary. */
export interface NulldownServer {
  /** Handles a Web request and returns a Web response. */
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface CompiledRoute extends NulldownServerRoute {
  segments: string[];
}

const jsonError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const normalizePath = (path: string): string => {
  if (!path.startsWith("/")) {
    throw new Error("Nulldown server route paths must start with '/'.");
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
};

const pathSegments = (path: string): string[] => {
  const normalized = normalizePath(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
};

const decodePathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const matchRoutePath = (
  route: CompiledRoute,
  pathname: string,
): NulldownServerRouteParams | null => {
  const requestSegments = pathSegments(pathname);
  if (route.segments.length !== requestSegments.length) return null;

  const params: NulldownServerRouteParams = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const routeSegment = route.segments[index];
    const requestSegment = requestSegments[index];
    if (routeSegment.startsWith(":")) {
      params[routeSegment.slice(1)] = decodePathSegment(requestSegment);
      continue;
    }
    if (routeSegment !== requestSegment) return null;
  }
  return params;
};

const normalizeMethod = (method: string): string => method.toUpperCase();

const methodMatches = (route: CompiledRoute, method: string): boolean =>
  route.method === "*" || route.method === method;

const allowHeader = (routes: CompiledRoute[], pathname: string): string => {
  const methods = new Set<string>();
  for (const route of routes) {
    if (matchRoutePath(route, pathname)) {
      if (route.method === "*") return "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT";
      methods.add(route.method);
    }
  }
  methods.add("OPTIONS");
  return [...methods].sort().join(", ");
};

/** Creates a packageable Web `Request`/`Response` server facade for Nulldown routes. */
export const createNulldownServer = ({
  routes,
  onError,
  notFound,
}: CreateNulldownServerOptions): NulldownServer => {
  const compiledRoutes = routes.map((route): CompiledRoute => ({
    ...route,
    method: route.method === "*" ? "*" : normalizeMethod(route.method) as NulldownServerMethod,
    path: normalizePath(route.path),
    segments: pathSegments(route.path),
  }));

  return {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const method = normalizeMethod(request.method);
      const pathMatches = compiledRoutes
        .map((route) => ({ route, params: matchRoutePath(route, url.pathname) }))
        .filter((entry): entry is { route: CompiledRoute; params: NulldownServerRouteParams } =>
          entry.params !== null,
        );

      const match = pathMatches.find((entry) => methodMatches(entry.route, method));
      if (!match) {
        if (pathMatches.length > 0) {
          const headers = { Allow: allowHeader(compiledRoutes, url.pathname) };
          return method === "OPTIONS"
            ? new Response(null, { status: 204, headers })
            : new Response("Method Not Allowed", { status: 405, headers });
        }
        return notFound ? await notFound(request) : jsonError(404, "not_found", "Route not found.");
      }

      const context: NulldownServerRouteContext = {
        request,
        url,
        params: match.params,
      };

      try {
        return await match.route.handler(context);
      } catch (error) {
        const response = await onError?.(error, context);
        return response ?? jsonError(500, "internal_error", "Internal server error.");
      }
    },
  };
};
