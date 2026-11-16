export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly detail?: unknown,
    ) {
        super(message);
    }
}

/** Expected failure: print the message, exit non-zero, no stack. */
export class CliError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
    ) {
        super(message);
    }
}

export type TreeFile = { path: string; hash: string; size: number };

export class Client {
    constructor(
        readonly apiUrl: string,
        readonly token: string | undefined,
    ) {}

    async raw(method: string, path: string, init: { json?: unknown; body?: Uint8Array } = {}): Promise<Response> {
        const headers: Record<string, string> = {};
        if (this.token) headers.authorization = `Bearer ${this.token}`;
        let body: BodyInit | undefined;
        if (init.json !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(init.json);
        } else if (init.body) {
            headers["content-type"] = "application/octet-stream";
            body = init.body as unknown as BodyInit;
        }
        let response: Response;
        try {
            response = await fetch(this.apiUrl + path, { method, headers, body });
        } catch (error) {
            const cause = (error as { cause?: { code?: string } }).cause?.code;
            throw new CliError(`cannot reach ${this.apiUrl}${cause ? ` (${cause})` : ""}`);
        }
        if (response.ok) return response;
        let code = "http_error";
        let message = `${response.status} ${response.statusText}`;
        let detail: unknown;
        try {
            const parsed = (await response.json()) as { error?: { code?: string; message?: string; detail?: unknown } };
            if (parsed.error) {
                code = parsed.error.code ?? code;
                message = parsed.error.message ?? message;
                detail = parsed.error.detail;
            }
        } catch {
            // non-JSON error body
        }
        if (response.status === 401 && !this.token) message += " (not logged in: run `forge login`)";
        throw new ApiError(response.status, code, message, detail);
    }

    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
        return (await (await this.raw(method, path, { json: body })).json()) as T;
    }

    get = <T>(path: string) => this.json<T>("GET", path);
    post = <T>(path: string, body?: unknown) => this.json<T>("POST", path, body ?? {});

    async tree(problemId: string): Promise<{ version: number; files: TreeFile[] }> {
        return this.get(`/problems/${problemId}/tree`);
    }

    async blob(problemId: string, hash: string): Promise<Uint8Array> {
        return new Uint8Array(await (await this.raw("GET", `/problems/${problemId}/blobs/${hash}`)).arrayBuffer());
    }

    async uploadBlob(problemId: string, bytes: Uint8Array) {
        return (await (await this.raw("POST", `/problems/${problemId}/blobs`, { body: bytes })).json()) as {
            hash: string;
            size: number;
        };
    }
}
