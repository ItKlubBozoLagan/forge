import { createHash } from "node:crypto";

import { Client } from "minio";

import { Config } from "./config";
import { Sql } from "./db";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
/** Hash of a list of parts, unambiguous regardless of the parts' contents. */
export const keyOf = (...parts: Array<string | number>) => sha256(JSON.stringify(parts));

export type TreeEntry = { hash: string; size: number };
export type Tree = Record<string, TreeEntry>;

export class BlobStore {
    private client: Client;
    private bucket: string;
    private cache = new Map<string, Buffer>();
    private cacheBytes = 0;

    constructor(config: Config["s3"], private sql: Sql) {
        this.client = new Client({
            endPoint: config.endPoint,
            port: config.port,
            useSSL: config.useSSL,
            accessKey: config.accessKey,
            secretKey: config.secretKey,
        });
        this.bucket = config.bucket;
    }

    async init() {
        if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
    }

    private remember(key: string, data: Buffer) {
        if (data.length > 1024 * 1024 || this.cache.has(key)) return;
        this.cache.set(key, data);
        this.cacheBytes += data.length;
        while (this.cacheBytes > 128 * 1024 * 1024) {
            const oldest = this.cache.keys().next().value as string;
            this.cacheBytes -= this.cache.get(oldest)!.length;
            this.cache.delete(oldest);
        }
    }

    async put(workspaceId: string, data: Buffer): Promise<TreeEntry> {
        const hash = sha256(data);
        const known = await this.sql`select 1 from blobs where workspace_id = ${workspaceId} and hash = ${hash}`;
        if (known.length === 0) {
            await this.client.putObject(this.bucket, `${workspaceId}/${hash}`, data, data.length);
            await this.sql`insert into blobs (workspace_id, hash, size) values (${workspaceId}, ${hash}, ${data.length}) on conflict do nothing`;
        }
        this.remember(`${workspaceId}/${hash}`, data);
        return { hash, size: data.length };
    }

    async has(workspaceId: string, hash: string): Promise<number | undefined> {
        const rows = await this.sql<{ size: string }[]>`select size from blobs where workspace_id = ${workspaceId} and hash = ${hash}`;
        return rows[0] ? Number(rows[0].size) : undefined;
    }

    /** Reads a blob through a workspace's reference to it; unknown references read as missing. */
    async get(workspaceId: string, hash: string): Promise<Buffer | undefined> {
        if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
        const key = `${workspaceId}/${hash}`;
        const cached = this.cache.get(key);
        if (cached) return cached;
        if ((await this.has(workspaceId, hash)) === undefined) return undefined;
        const stream = await this.client.getObject(this.bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        const data = Buffer.concat(chunks);
        this.remember(key, data);
        return data;
    }

    async text(workspaceId: string, hash: string): Promise<string> {
        const data = await this.get(workspaceId, hash);
        if (!data) throw new Error(`blob ${hash} is missing`);
        return data.toString("utf8");
    }
}
