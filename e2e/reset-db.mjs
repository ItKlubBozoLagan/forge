// Every e2e run starts from an empty database; the API migrates it when it boots.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url || !/forge_e2e/.test(url)) throw new Error("refusing to reset a database that is not the e2e database");
const sql = postgres(url, { onnotice: () => {} });
await sql`drop schema public cascade`;
await sql`create schema public`;
await sql.end();
