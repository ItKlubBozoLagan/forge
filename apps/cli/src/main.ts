import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { TEMPLATE_FORMATS, languageOf } from "@forge/core";
import { Command } from "commander";

import { ApiError, Client, CliError } from "./client";
import { DEFAULT_API, DEFAULT_WEB, loadConfig, saveConfig, stripSlash } from "./config";
import { loopbackLogin } from "./login";
import { downloadFiles, fetchRemote, loadCheckout, pull, push, status, type Checkout } from "./ops";
import {
    printBuild,
    waitForBuild,
    type BuildDetail,
    type BuildOutput,
    type StressOutput,
} from "./render";
import { bold, dim, green, info, openBrowser, red } from "./util";
import { findRoot, writeState } from "./workdir";

type Me = {
    user: { id: string; name: string; email: string | null };
    workspaces: Array<{ id: string; name: string; role: string }>;
};
type ProblemRow = { id: string; name: string; title: string; role: string; lastResult: string | null };

const makeClient = (apiUrl?: string) => {
    const config = loadConfig();
    return new Client(stripSlash(apiUrl ?? config.apiUrl), config.token);
};

const checkout = (): Checkout => loadCheckout(findRoot(), makeClient);

const pickWorkspace = async (client: Client, requested?: string): Promise<string> => {
    if (requested) return requested;
    const me = await client.get<Me>("/me");
    if (me.workspaces.length === 1) return me.workspaces[0]!.id;
    if (me.workspaces.length === 0) throw new CliError("you have no workspaces");
    throw new CliError(
        `pass --workspace <id>; your workspaces: ${me.workspaces.map((w) => `${w.id} (${w.name})`).join(", ")}`,
    );
};

const cloneInto = async (client: Client, problemId: string, dir?: string) => {
    const problem = await client.get<{ id: string; name: string }>(`/problems/${problemId}`);
    const target = resolve(dir ?? problem.name);
    if (existsSync(target) && readdirSync(target).length > 0) throw new CliError(`${target} exists and is not empty`);
    mkdirSync(target, { recursive: true });
    const state = { apiUrl: client.apiUrl, problemId, files: {} as Record<string, string> };
    const cp: Checkout = { root: target, state, client };
    const { hashes } = await fetchRemote(cp);
    await downloadFiles(
        cp,
        Object.entries(hashes).map(([path, hash]) => ({ path, hash })),
    );
    writeState(target, { ...state, files: hashes });
    info(`cloned problem ${problem.name} (${problemId}) into ${target} (${Object.keys(hashes).length} files)`);
};

const run = async (cp: Checkout, build: { revision?: string; remeasure?: boolean; clean?: boolean }, json: boolean): Promise<number> => {
    const { id } = await cp.client.post<{ id: string }>(`/problems/${cp.state.problemId}/builds`, {
        ...(build.revision ? { revision: build.revision } : {}),
        ...(build.remeasure ? { remeasure: true } : {}),
        ...(build.clean ? { clean: true } : {}),
    });
    return showBuild(cp.client, id, json);
};

const showBuild = async (client: Client, buildId: string, json: boolean): Promise<number> => {
    const result = await waitForBuild<BuildOutput>(client, buildId);
    if (json) {
        info(JSON.stringify(result, null, 2));
        return result.status === "failed" ? 2 : result.result === "green" ? 0 : 1;
    }
    return printBuild(result as BuildDetail<BuildOutput>);
};

const program = new Command("forge").description("Forge problem-preparation client").showHelpAfterError();

/** Wraps an action: expected errors print to stderr without a stack. */
const act =
    <A extends unknown[]>(fn: (...args: A) => Promise<number | void>) =>
    async (...args: A) => {
        try {
            const code = await fn(...args);
            process.exitCode = code ?? 0;
        } catch (error) {
            if (error instanceof CliError) console.error(`error: ${error.message}`);
            else if (error instanceof ApiError) {
                console.error(`error: ${error.message}`);
                if (error.detail !== undefined) console.error(JSON.stringify(error.detail));
            } else if (error instanceof Error) console.error(`error: ${error.message}`);
            else console.error(`error: ${String(error)}`);
            process.exitCode = error instanceof CliError ? error.exitCode : 1;
        }
    };

program
    .command("login")
    .description("store an API token (browser flow, or --token)")
    .option("--api <url>", "API base URL")
    .option("--web <url>", "web app URL")
    .option("--token <token>", "personal access token")
    .action(
        act(async (opts: { api?: string; web?: string; token?: string }) => {
            const current = loadConfig();
            const apiUrl = stripSlash(opts.api ?? (current.apiUrl || DEFAULT_API));
            const webUrl = stripSlash(opts.web ?? (current.webUrl || DEFAULT_WEB));
            const token = opts.token ?? (await loopbackLogin(webUrl));
            const me = await new Client(apiUrl, token).get<Me>("/me");
            saveConfig({ apiUrl, webUrl, token });
            info(`logged in as ${me.user.name} (${apiUrl})`);
        }),
    );

program
    .command("whoami")
    .description("show the current user and workspaces")
    .action(
        act(async () => {
            const me = await makeClient().get<Me>("/me");
            info(`${me.user.name}${me.user.email ? ` <${me.user.email}>` : ""}`);
            for (const w of me.workspaces) info(`  workspace ${w.id}  ${w.name}  (${w.role})`);
        }),
    );

program
    .command("list")
    .description("list problems")
    .option("--workspace <id>", "workspace id (default: all)")
    .action(
        act(async (opts: { workspace?: string }) => {
            const client = makeClient();
            const me = await client.get<Me>("/me");
            const workspaces = opts.workspace ? [{ id: opts.workspace, name: opts.workspace }] : me.workspaces;
            for (const w of workspaces) {
                const problems = await client.get<ProblemRow[]>(`/workspaces/${w.id}/problems`);
                if (workspaces.length > 1) info(bold(`workspace ${w.id} ${w.name}`));
                if (problems.length === 0) info(dim("  (no problems)"));
                const rows = problems.map((p) => [p.id, p.name, p.title, p.role, p.lastResult ?? "-"]);
                const widths = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
                for (const r of rows) {
                    const result = r[4] === "green" ? green("green") : r[4] === "red" ? red("red") : "-";
                    info(`${r.slice(0, 4).map((cell, c) => cell.padEnd(widths[c]!)).join("  ")}  ${result}`);
                }
            }
        }),
    );

program
    .command("new <name>")
    .description("create a problem and clone it")
    .argument("[dir]", "target directory (default: the name)")
    .requiredOption("--title <title>", "problem title")
    .option("--template <template>", TEMPLATE_FORMATS.join("|"), "ioi")
    .option("--workspace <id>", "workspace id")
    .action(
        act(async (name: string, dir: string | undefined, opts: { title: string; template: string; workspace?: string }) => {
            if (!(TEMPLATE_FORMATS as readonly string[]).includes(opts.template)) throw new CliError(`unknown template ${opts.template}`);
            const client = makeClient();
            const workspace = await pickWorkspace(client, opts.workspace);
            const created = await client.post<{ id: string; name: string }>(`/workspaces/${workspace}/problems`, {
                name,
                title: opts.title,
                template: opts.template,
            });
            info(`created problem ${created.name} (${created.id})`);
            await cloneInto(client, created.id, dir ?? name);
        }),
    );

program
    .command("import-polygon <zip>")
    .description("create a problem from a Polygon package and clone it")
    .argument("[dir]", "target directory (default: the problem's name)")
    .option("--workspace <id>", "workspace id")
    .action(
        act(async (zip: string, dir: string | undefined, opts: { workspace?: string }) => {
            const client = makeClient();
            const workspace = await pickWorkspace(client, opts.workspace);
            const response = await client.raw("POST", `/workspaces/${workspace}/import/polygon`, { body: new Uint8Array(readFileSync(zip)) });
            const created = (await response.json()) as { id: string; name: string; notes: string[] };
            info(`imported problem ${created.name} (${created.id})`);
            for (const note of created.notes) info(`note: ${note}`);
            await cloneInto(client, created.id, dir ?? created.name);
        }),
    );

program
    .command("clone <problemId> [dir]")
    .description("download a problem's working copy")
    .action(act(async (problemId: string, dir?: string) => void (await cloneInto(makeClient(), problemId, dir))));

program
    .command("status")
    .description("local and remote changes relative to the base")
    .action(
        act(async () => {
            const { conflicts } = await status(checkout());
            return conflicts > 0 ? 1 : 0;
        }),
    );

program
    .command("pull")
    .description("apply remote changes to local files")
    .action(act(async () => ((await pull(checkout())) ? 1 : 0)));

program
    .command("push")
    .description("upload local changes")
    .option("--force", "overwrite remote changes")
    .action(act(async (opts: { force?: boolean }) => void (await push(checkout(), opts.force))));

program
    .command("build")
    .description("push, build and show the result")
    .option("--no-push", "do not push local changes first")
    .option("--remeasure", "re-measure timings")
    .option("--clean", "ignore cached results and rebuild everything")
    .option("--revision <id>", "build a revision instead of the working copy")
    .option("--json", "print the raw build JSON")
    .action(
        act(async (opts: { push: boolean; remeasure?: boolean; clean?: boolean; revision?: string; json?: boolean }) => {
            const cp = checkout();
            if (opts.push && !opts.revision) await push(cp);
            return run(cp, opts, Boolean(opts.json));
        }),
    );

program
    .command("commit")
    .description("push, create a revision and wait for its build")
    .requiredOption("-m, --message <message>", "revision message")
    .option("--no-wait", "do not wait for the build")
    .action(
        act(async (opts: { message: string; wait: boolean }) => {
            const cp = checkout();
            await push(cp);
            const rev = await cp.client.post<{ id: string; number: number; buildId: string }>(
                `/problems/${cp.state.problemId}/revisions`,
                { message: opts.message },
            );
            info(`created revision ${rev.number} (id ${rev.id}), build ${rev.buildId}`);
            if (!opts.wait) return 0;
            return showBuild(cp.client, rev.buildId, false);
        }),
    );

program
    .command("invoke <file>")
    .description("run a solution that is not part of the package")
    .option("--name <name>", "display name (default: file name)")
    .option("--language <lang>", "language (default: from the extension)")
    .option("--json", "print the raw build JSON")
    .action(
        act(async (file: string, opts: { name?: string; language?: string; json?: boolean }) => {
            const cp = checkout();
            const language = opts.language ?? languageOf(file);
            if (!language) throw new CliError(`cannot infer the language of ${file}; pass --language`);
            if (!existsSync(file)) throw new CliError(`no such file: ${file}`);
            await push(cp); // invocations run against the working copy on the server
            const { id } = await cp.client.post<{ id: string }>(`/problems/${cp.state.problemId}/invocations`, {
                name: opts.name ?? basename(file),
                language,
                source: readFileSync(file, "utf8"),
            });
            const result = await waitForBuild<BuildOutput>(cp.client, id);
            if (opts.json) {
                info(JSON.stringify(result, null, 2));
                return result.status === "failed" ? 2 : 0;
            }
            if (result.status === "failed" || !result.output) {
                console.error(red(`invocation failed: ${result.error ?? "unknown error"}`));
                return 2;
            }
            const { report } = result.output;
            for (const issue of report.issues) info(`${issue.severity}: ${issue.message}`);
            for (const s of report.solutions) {
                info(`${s.path}: score ${s.score}/${s.maxScore}, max time ${s.maxTimeMs}ms`);
                for (const g of s.groups) {
                    info(`  ${g.group.padEnd(12)} ${g.summary === "AC" ? green(g.summary) : red(g.summary)}  ${g.score}/${g.maxScore}  ${g.maxTimeMs}ms`);
                }
            }
            return report.solutions.every((s) => s.ok) ? 0 : 1;
        }),
    );

program
    .command("stress")
    .description("stress-test a solution against the main one")
    .requiredOption("--generator <name>", "generator name from problem.yaml")
    .requiredOption("--solution <path>", "solution path in the package")
    .requiredOption("--group <group>", "group whose constraints tests must satisfy")
    .requiredOption("--args <args>", "generator arguments; must contain {seed}")
    .option("--count <n>", "number of tests", "100")
    .option("--seed <n>", "first seed", "1")
    .action(
        act(async (opts: { generator: string; solution: string; group: string; args: string; count: string; seed: string }) => {
            if (!opts.args.includes("{seed}")) throw new CliError("--args must contain {seed}");
            const cp = checkout();
            await push(cp); // stress runs against the working copy on the server
            const { id } = await cp.client.post<{ id: string }>(`/problems/${cp.state.problemId}/stress`, {
                generator: opts.generator,
                args: opts.args,
                count: Number(opts.count),
                seedStart: Number(opts.seed),
                solution: opts.solution,
                group: opts.group,
            });
            const result = await waitForBuild<StressOutput>(cp.client, id);
            if (result.status === "failed" || !result.output) {
                console.error(red(`stress run failed: ${result.error ?? "unknown error"}`));
                return 2;
            }
            const out = result.output;
            info(`${out.passed}/${out.total} passed`);
            for (const e of out.errors) info(red(`error: ${e}`));
            for (const i of out.invalid) info(`invalid test (generator bug)  ${i.args}: ${i.message}`);
            for (const f of out.failures) info(`${red("FAIL")} ${f.verdict} args: ${f.args}${f.message ? `  ${f.message}` : ""} (${f.timeMs}ms)`);
            return out.failures.length + out.invalid.length + out.errors.length > 0 ? 1 : 0;
        }),
    );

program
    .command("download [target]")
    .description("download the package archive, or a build's tests, as a zip")
    .option("--tests <buildId>", "download the tests of this build")
    .option("--revision <id>", "download the archive of a revision")
    .action(
        act(async (target: string | undefined, opts: { tests?: string; revision?: string }) => {
            let client = makeClient();
            let path = `/builds/${opts.tests}/tests.zip`;
            if (!opts.tests) {
                const cp = checkout();
                client = cp.client;
                path = `/problems/${cp.state.problemId}/archive${opts.revision ? `?revision=${encodeURIComponent(opts.revision)}` : ""}`;
            }
            const response = await client.raw("GET", path);
            const disposition = response.headers.get("content-disposition") ?? "";
            const suggested = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
            const name = suggested ? basename(decodeURIComponent(suggested)) : opts.tests ? "tests.zip" : "package.zip";
            let file = resolve(name);
            if (target) {
                const given = resolve(target);
                file = existsSync(given) && statSync(given).isDirectory() ? resolve(given, name) : given;
            }
            writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
            info(`saved ${file}`);
        }),
    );

program
    .command("open")
    .description("print and open the problem's web page")
    .action(
        act(async () => {
            const cp = checkout();
            const url = `${loadConfig().webUrl}/p/${cp.state.problemId}/builds`;
            info(url);
            openBrowser(url);
        }),
    );

await program.parseAsync(process.argv);
