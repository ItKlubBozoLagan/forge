import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInterface } from "node:readline";

import { CheckRequest, CommunicationRequest, Program, Runner, RunInput, RunOutcome, RunRequest, RunResult } from "./types";

type Executed = { code: number | null; stdout: string; stderr: string; timeMs: number; timedOut: boolean };

/** What a program reads: the text, or the bytes of an input that is not text. */
const bytesOf = (input: RunInput): string | Buffer => (input.stdinBase64 !== undefined ? Buffer.from(input.stdinBase64, "base64") : input.stdin);

const execute = (command: string, args: string[], stdin: string | Buffer, timeoutMs: number, cwd?: string): Promise<Executed> =>
    new Promise((resolve) => {
        const started = process.hrtime.bigint();
        const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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

type Interaction = { code: number | null; stderr: string; timeMs: number; timedOut: boolean; verdict: string | undefined };

/**
 * Mirrors the evaluator: the interactor reads the test, one extra newline and then whatever
 * the solution prints; what it prints goes to the solution; its verdict is the content of
 * `interactor_meta.out` in its working directory.
 */
const interact = async (
    solution: { command: string; args: string[] },
    interactor: { command: string; args: string[] },
    directory: string,
    stdin: string,
    timeoutMs: number,
): Promise<Interaction> => {
    await mkdir(directory, { recursive: true });
    const started = process.hrtime.bigint();
    const judge = spawn(interactor.command, interactor.args, { cwd: directory, stdio: ["pipe", "pipe", "ignore"] });
    const child = spawn(solution.command, solution.args, { stdio: ["pipe", "pipe", "pipe"] });
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        judge.kill("SIGKILL");
    }, timeoutMs);
    for (const stream of [judge.stdin, child.stdin]) stream.on("error", () => {});
    judge.on("error", () => {});
    child.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    judge.stdin.write(`${stdin}\n`);
    child.stdout.pipe(judge.stdin);
    judge.stdout.pipe(child.stdin);
    const closed = (process: { on(event: "close", listener: (code: number | null) => void): unknown }) =>
        new Promise<number | null>((resolve) => process.on("close", (code) => resolve(code)));
    const [code] = await Promise.all([closed(child), closed(judge)]);
    clearTimeout(timer);
    const verdict = await readFile(join(directory, "interactor_meta.out"), "utf8").then(
        (text) => text.trim(),
        () => undefined,
    );
    return {
        code,
        stderr: Buffer.concat(err).toString("utf8"),
        timeMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        timedOut,
        verdict,
    };
};

/**
 * Mirrors the evaluator's communication evaluation: the manager reads the length of the test,
 * the test, and then `K:<line>` for every line instance K prints (`K!` when it closes its
 * output); every `K:<text>` the manager prints goes to instance K, `K!` closes its input. The
 * verdict is the content of `interactor_meta.out`.
 */
const communicate = async (
    solution: { command: string; args: string[] },
    manager: { command: string; args: string[] },
    directory: string,
    stdin: string | Buffer,
    processes: number,
    timeoutMs: number,
): Promise<Interaction> => {
    await mkdir(directory, { recursive: true });
    const started = process.hrtime.bigint();
    const judge = spawn(manager.command, manager.args, { cwd: directory, stdio: ["pipe", "pipe", "ignore"] });
    const instances = Array.from({ length: processes }, () => spawn(solution.command, solution.args, { stdio: ["pipe", "pipe", "pipe"] }));
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        judge.kill("SIGKILL");
        for (const instance of instances) instance.kill("SIGKILL");
    }, timeoutMs * 2);
    judge.stdin.on("error", () => {});
    judge.on("error", () => {});
    const data = typeof stdin === "string" ? Buffer.from(stdin, "utf8") : stdin;
    judge.stdin.write(Buffer.concat([Buffer.from(`${data.length}\n`), data, Buffer.from("\n")]));
    instances.forEach((instance, index) => {
        instance.stdin.on("error", () => {});
        instance.on("error", () => {});
        instance.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        const lines = createInterface({ input: instance.stdout });
        lines.on("line", (line) => judge.stdin.write(`${index + 1}:${line}\n`));
        lines.on("close", () => judge.stdin.write(`${index + 1}!\n`));
    });
    const routed = createInterface({ input: judge.stdout });
    routed.on("line", (line) => {
        const match = /^(\d+)([:!])(.*)$/.exec(line);
        const target = match ? instances[Number(match[1]) - 1] : undefined;
        if (!match || !target) return;
        if (match[2] === "!") target.stdin.end();
        else target.stdin.write(`${match[3]}\n`);
    });
    routed.on("close", () => {
        for (const instance of instances) instance.stdin.end();
    });
    const closed = (child: { on(event: "close", listener: (code: number | null) => void): unknown }) =>
        new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const codes = await Promise.all([...instances.map(closed), closed(judge)]);
    clearTimeout(timer);
    const verdict = await readFile(join(directory, "interactor_meta.out"), "utf8").then(
        (text) => text.trim(),
        () => undefined,
    );
    return {
        code: codes.slice(0, processes).find((code) => code !== 0) ?? 0,
        stderr: Buffer.concat(err).toString("utf8"),
        timeMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        timedOut,
        verdict,
    };
};

/** Maps what a checker or interactor reported to a run status. */
const verdictOf = (text: string): Pick<RunOutcome, "status" | "data" | "message"> => {
    if (text.startsWith("custom:")) return { status: "custom", data: text.slice("custom:".length) };
    if (["ac", "accepted"].includes(text.toLowerCase())) return { status: "accepted" };
    if (["wa", "wrong_answer"].includes(text.toLowerCase())) return { status: "wrong_answer" };
    return { status: "judge_error", message: `the checker printed "${text.slice(0, 100)}"` };
};

/** Programs run inside the job's scratch directory: checkers may write files next to themselves. */
const runChecker = async (checker: { command: string; args: string[] }, stdin: string, expected: string, output: string, cwd: string) => {
    const separator = `[${randomBytes(16).toString("hex")}]\n`;
    const checkerInput = `${separator}${stdin}\n${separator}${expected}\n${separator}${output}\n${separator}`;
    const checked = await execute(checker.command, checker.args, checkerInput, 30_000, cwd);
    if (checked.code !== 0) return { status: "judge_error" as const, message: "the checker crashed" };
    return verdictOf(checked.stdout.trim());
};

/** The evaluator's default comparison, reproduced exactly: every line trimmed, lines joined. */
const tokens = (text: string) =>
    text
        .split("\n")
        .map((line) => line.trim())
        .join(" ")
        .trim();

/**
 * Runs programs directly on this machine with no sandbox. It exists so the system can be
 * developed and tested without an evaluator; the configuration refuses it in production.
 */
export class LocalRunner implements Runner {
    readonly pool = "local";
    readonly hardwareClass = "local";
    readonly capabilities = { binaryInput: true, communication: true };

    async communicate(request: CommunicationRequest): Promise<RunResult> {
        const directory = await mkdtemp(join(tmpdir(), "forge-talk-"));
        try {
            const program = await compile(directory, "program", request.program);
            if ("error" in program) return { compileError: program.error, runs: [] };
            const manager = await compile(directory, "manager", request.manager);
            if ("error" in manager) return { compileError: manager.error, runs: [] };
            const runs: RunOutcome[] = [];
            for (const input of request.inputs) {
                const result = await communicate(program, manager, join(directory, `talk-${runs.length}`), bytesOf(input), request.processes, request.timeLimitMs);
                const base = { id: input.id, timeMs: result.timeMs, memoryKb: 0 };
                const rejected = result.verdict !== undefined && verdictOf(result.verdict).status !== "accepted";
                if (rejected) runs.push({ ...base, ...verdictOf(result.verdict!) });
                else if (result.timedOut) runs.push({ ...base, status: "time_limit_exceeded" });
                else if (result.code !== 0) runs.push({ ...base, status: "runtime_error", message: result.stderr.slice(0, 2000) });
                else if (result.verdict === undefined) runs.push({ ...base, status: "judge_error", message: "the manager wrote no verdict" });
                else runs.push({ ...base, ...verdictOf(result.verdict) });
            }
            return { runs };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

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
                    const result = await interact(
                        program,
                        checker as { command: string; args: string[] },
                        join(directory, `interaction-${runs.length}`),
                        input.stdin,
                        request.timeLimitMs,
                    );
                    const base = { id: input.id, timeMs: result.timeMs, memoryKb: 0 };
                    // an interactor that already rejected the interaction decides the verdict,
                    // whatever happens to the solution once its input closes
                    const rejected = result.verdict !== undefined && verdictOf(result.verdict).status !== "accepted";
                    if (result.timedOut) runs.push({ ...base, status: "time_limit_exceeded" });
                    else if (rejected) runs.push({ ...base, ...verdictOf(result.verdict!) });
                    else if (result.code !== 0) runs.push({ ...base, status: "runtime_error", message: result.stderr.slice(0, 2000) });
                    else if (result.verdict === undefined) runs.push({ ...base, status: "judge_error", message: "the interactor wrote no verdict" });
                    else runs.push({ ...base, ...verdictOf(result.verdict) });
                    continue;
                }
                const result = await execute(program.command, program.args, bytesOf(input), request.timeLimitMs, directory);
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
                runs.push({
                    ...base,
                    ...(await runChecker(checker as { command: string; args: string[] }, input.stdin, input.expected ?? "", result.stdout, directory)),
                    stdout: result.stdout,
                });
            }
            return { runs };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    async check(request: CheckRequest): Promise<RunResult> {
        const directory = await mkdtemp(join(tmpdir(), "forge-check-"));
        try {
            let checker: Compiled | undefined;
            if (typeof request.checking === "object") {
                checker = await compile(directory, "checker", request.checking);
                if ("error" in checker) return { compileError: checker.error, runs: [] };
            }
            const runs: RunOutcome[] = [];
            for (const input of request.inputs) {
                const base = { id: input.id, timeMs: 0, memoryKb: 0 };
                if (checker && "command" in checker)
                    runs.push({ ...base, ...(await runChecker(checker, input.stdin, input.expected, input.output, directory)) });
                else runs.push({ ...base, status: tokens(input.output) === tokens(input.expected) ? "accepted" : "wrong_answer" });
            }
            return { runs };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    async alive() {
        return true;
    }

    async close() {}
}
