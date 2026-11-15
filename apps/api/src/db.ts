import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

export type Sql = postgres.Sql;

export const connect = (url: string): Sql =>
    postgres(url, { max: 10, onnotice: () => {} });

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

export const migrate = async (sql: Sql) => {
    await sql`create table if not exists migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await sql<{ name: string }[]>`select name from migrations`).map((row) => row.name));
    for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) {
        if (applied.has(name)) continue;
        const text = await readFile(`${MIGRATIONS}/${name}`, "utf8");
        await sql.begin(async (tx) => {
            await tx.unsafe(text);
            await tx`insert into migrations (name) values (${name})`;
        });
    }
};
