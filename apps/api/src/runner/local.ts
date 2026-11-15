import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Program, Runner, RunOutcome, RunRequest, RunResult } from "./types";

type Executed = { code: number | null; stdout: string; stderr: string; timeMs: number; timedOut: boolean };

const execute = (command: string, args: string[], stdin: string, timeoutMs: number): Promise<Executed> =>
    new Promise((resolve) => {
        const started = process.hrtime.bigint();
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        child.stdin.on("error", () => {});
        child.on("error", () => {});
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
                code,
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(err).toString("utf8"),
                timeMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
                timedOut,
            });
        });
        child.stdin.end(stdin);
    });

type Compiled = { command: string; args: string[] } | { error: string };

const compile = async (directory: string, name: string, program: Program): Promise<Compiled> => {
    if (program.language === "python") {
        const file = join(directory, `${name}.py`);
        await writeFile(file, program.source);
        const check = await execute("python3", ["-m", "py_compile", file], "", 30_000);
        if (check.code !== 0) return { error: check.stderr };
        return { command: "python3", args: [file] };
    }
    if (program.language === "c" || program.language === "cpp") {
        const file = join(directory, `${name}.${program.language}`);
        const binary = join(directory, name);
        await writeFile(file, program.source);
        const compiler = program.language === "c" ? "gcc" : "g++";
        const flags = program.language === "c" ? ["-O2", "-lm"] : ["-O2", "-std=c++17"];
        const result = await execute(compiler, [...flags, "-o", binary, file], "", 60_000);
        if (result.code !== 0) return { error: result.stderr };
        return { command: binary, args: [] };
    }
    return { error: `the local runner does not support ${program.language}` };
};

const tokens = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/**
 * Runs programs directly on this machine with no sandbox. It exists so the system can be
 * developed and tested without an evaluator; the configuration refuses it in production.
 */
export class LocalRunner implements Runner {
    readonly pool = "local";
    readonly hardwareClass = "local";

    async run(request: RunRequest): Promise<RunResult> {
        const directory = await mkdtemp(join(tmpdir(), "forge-run-"));
        try {
            const program = await compile(directory, "program", request.program);
            if ("error" in program) return { compileError: program.error, runs: [] };
            let checker: Compiled | undefined;
            if (typeof request.checking === "object") {
                checker = await compile(directory, "checker", request.checking);
                if ("error" in checker) return { compileError: checker.error, runs: [] };
            }
            const runs: RunOutcome[] = [];
            for (const input of request.inputs) {
                if (request.interactive) {
                    runs.push({ id: input.id, status: "judge_error", timeMs: 0, memoryKb: 0, message: "the local runner cannot run interactive tasks" });
                    continue;
                }
                const result = await execute(program.command, program.args, input.stdin, request.timeLimitMs);
                const base = { id: input.id, timeMs: result.timeMs, memoryKb: 0 };
                if (result.timedOut) {
                    runs.push({ ...base, status: "time_limit_exceeded" });
                    continue;
                }
                if (result.code !== 0) {
                    runs.push({ ...base, status: "runtime_error", message: result.stderr.slice(0, 2000) });
                    continue;
                }
                if (request.checking === "capture") {
                    runs.push({ ...base, status: "accepted", stdout: result.stdout });
                    continue;
                }
                if (request.checking === "tokens") {
                    const same = tokens(result.stdout) === tokens(input.expected ?? "");
                    runs.push({ ...base, status: same ? "accepted" : "wrong_answer", stdout: result.stdout });
                    continue;
                }
                const separator = `[${randomBytes(16).toString("hex")}]\n`;
                const checkerInput = `${separator}${input.stdin}\n${separator}${input.expected ?? ""}\n${separator}${result.stdout}\n${separator}`;
                const checked = await execute((checker as { command: string }).command, (checker as { args: string[] }).args, checkerInput, 30_000);
                const text = checked.stdout.trim();
                if (checked.code !== 0) runs.push({ ...base, status: "judge_error", message: "the checker crashed" });
                else if (text.startsWith("custom:")) runs.push({ ...base, status: "custom", data: text.slice("custom:".length), stdout: result.stdout });
                else if (["ac", "accepted"].includes(text.toLowerCase())) runs.push({ ...base, status: "accepted", stdout: result.stdout });
                else if (["wa", "wrong_answer"].includes(text.toLowerCase())) runs.push({ ...base, status: "wrong_answer", stdout: result.stdout });
                else runs.push({ ...base, status: "judge_error", message: `the checker printed "${text.slice(0, 100)}"` });
            }
            return { runs };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    async close() {}
}
