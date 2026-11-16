/** Thin client for the Forge HTTP API. Every call goes to the same origin under /api. */

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public detail?: unknown,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

type Options = {
    /** JSON body. */
    json?: unknown;
    /** Raw body (sent as application/octet-stream). */
    bytes?: BodyInit;
    headers?: Record<string, string>;
    signal?: AbortSignal;
};

const errorFrom = async (response: Response): Promise<ApiError> => {
    try {
        const body = (await response.json()) as {
            error?: { code?: string; message?: string; detail?: unknown };
        };
        if (body.error)
            return new ApiError(
                response.status,
                body.error.code ?? "error",
                body.error.message ?? `Request failed (${response.status})`,
                body.error.detail,
            );
    } catch {
        // not JSON
    }
    return new ApiError(
        response.status,
        "http",
        response.status >= 500
            ? `The server failed to answer (${response.status})`
            : `Request failed (${response.status})`,
    );
};

export const send = async (method: string, path: string, options: Options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (method !== "GET" && method !== "HEAD") headers["X-Forge-Csrf"] = "1";
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.json);
    } else if (options.bytes !== undefined) {
        headers["Content-Type"] = "application/octet-stream";
        body = options.bytes;
    }
    let response: Response;
    try {
        response = await fetch(`/api${path}`, {
            method,
            headers,
            body,
            credentials: "same-origin",
            signal: options.signal,
        });
    } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        throw new ApiError(0, "network", "Cannot reach the Forge server");
    }
    if (!response.ok) {
        const error = await errorFrom(response);
        if (error.status === 401) unauthorizedListener?.(error);
        throw error;
    }
    return response;
};

const json = async <T>(method: string, path: string, options?: Options): Promise<T> => {
    const response = await send(method, path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
};

export const api = {
    get: <T>(path: string, signal?: AbortSignal) => json<T>("GET", path, { signal }),
    post: <T>(path: string, body?: unknown) => json<T>("POST", path, { json: body ?? {} }),
    put: <T>(path: string, body?: unknown) => json<T>("PUT", path, { json: body ?? {} }),
    patch: <T>(path: string, body?: unknown) => json<T>("PATCH", path, { json: body ?? {} }),
    del: <T>(path: string) => json<T>("DELETE", path),
    /** Raw bytes plus the ETag (the content hash for files). */
    bytes: async (path: string, signal?: AbortSignal) => {
        const response = await send("GET", path, { signal });
        const buffer = await response.arrayBuffer();
        return { bytes: new Uint8Array(buffer), etag: response.headers.get("ETag") ?? undefined };
    },
    putBytes: <T>(path: string, bytes: Uint8Array, headers?: Record<string, string>) =>
        json<T>("PUT", path, { bytes: bytes as BodyInit, headers }),
};

let unauthorizedListener: ((error: ApiError) => void) | undefined;
/** Called whenever any request answers 401 (session expired or never signed in). */
export const onUnauthorized = (listener: (error: ApiError) => void) => {
    unauthorizedListener = listener;
};

export const errorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    return String(error);
};

export const encodeText = (text: string) => new TextEncoder().encode(text);
export const decodeText = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);
/** True when the bytes are not valid UTF-8 text (or contain NUL bytes). */
export const isBinary = (bytes: Uint8Array) => {
    if (bytes.subarray(0, 8192).includes(0)) return true;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return false;
    } catch {
        return true;
    }
};

export const q = (params: Record<string, string | number | undefined | null>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : "";
};
