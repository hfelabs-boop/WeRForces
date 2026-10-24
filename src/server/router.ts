// Minimal transport-independent router. Handlers receive parsed input and return a
// response object, so the same routes serve HTTP and in-process callers (the MCP server).

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RouteRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Absolute base URL of the server, e.g. http://127.0.0.1:8080 (for links). */
  baseUrl: string;
}

export interface RouteResponse {
  status?: number;
  /** JSON body (default) */
  json?: unknown;
  /** Raw text body with a content type. */
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

type Handler = (req: RouteRequest) => RouteResponse | Promise<RouteResponse>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/[.]/g, '\\.').replace(/\{(\w+)\}/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  get(path: string, h: Handler) {
    return this.add('GET', path, h);
  }
  post(path: string, h: Handler) {
    return this.add('POST', path, h);
  }
  put(path: string, h: Handler) {
    return this.add('PUT', path, h);
  }
  patch(path: string, h: Handler) {
    return this.add('PATCH', path, h);
  }
  delete(path: string, h: Handler) {
    return this.add('DELETE', path, h);
  }

  matches(path: string): boolean {
    return this.routes.some((r) => r.pattern.test(path));
  }

  async dispatch(input: Omit<RouteRequest, 'params'>): Promise<RouteResponse & { status: number }> {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(input.path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== input.method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        const res = await r.handler({ ...input, params });
        return { status: 200, ...res };
      } catch (err) {
        if (err instanceof HttpError) return { status: err.status, json: { error: { status: err.status, message: err.message } } };
        return { status: 500, json: { error: { status: 500, message: err instanceof Error ? err.message : String(err) } } };
      }
    }
    const status = pathMatched ? 405 : 404;
    return { status, json: { error: { status, message: pathMatched ? 'method not allowed' : 'unknown endpoint' } } };
  }
}
