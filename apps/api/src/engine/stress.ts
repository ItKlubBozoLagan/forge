import { judge, withPrelude } from "@forge/core";

import { Engine } from "./engine";

export type StressParams = {
    generator: string;
    /** Generator arguments; `{seed}` is replaced by each seed. */
    args: string;
    count: number;
    seedStart: number;
    /** The solution compared against the main solution. */
    solution: string;
    /** Group whose constraints the generated tests must satisfy. */
    group: string;
};

export type StressOutput = {
    total: number;
    passed: number;
    failures: Array<{ args: string; verdict: string; message?: string; inputHash: string; inputSize: number; timeMs: number }>;
    /** Generated tests the validator rejected: bugs in the generator, not in the solution. */
    invalid: Array<{ args: string; message: string }>;
    errors: string[];
};

/**
 * Stress testing: generate many small tests, answer them with the main solution and run
 * another solution against those answers. A failure is either a bug in one of the two
 * solutions or a counterexample worth promoting into the test set.
 */
export const runStress = async (engine: Engine, params: StressParams): Promise<StressOutput> => {
    const output: StressOutput = { total: params.count, passed: 0, failures: [], invalid: [], errors: [] };
    const { plan, issues } = await engine.plan();
    const blocking = issues.filter((issue) => issue.severity === "error");
    if (!plan || blocking.length > 0) {
        output.errors = blocking.map((issue) => issue.message);
        return output;
    }
    const generatorPath = plan.manifest.generators[params.generator];
    const group = plan.groups.find((candidate) => candidate.name === params.group);
    const candidate = plan.solutions.find((solution) => solution.path === params.solution);
    if (!generatorPath) output.errors.push(`Unknown generator "${params.generator}"`);
    if (!group) output.errors.push(`Unknown group "${params.group}"`);
    if (!candidate) output.errors.push(`Unknown solution "${params.solution}"`);
    if (!plan.main) output.errors.push("The package has no main solution");
    if (candidate?.outputs || plan.main?.outputs)
        output.errors.push("Stress testing needs programs: a directory of outputs cannot answer new tests");
    if (!params.args.includes("{seed}")) output.errors.push("The arguments must contain {seed}");
    if (!generatorPath || !group || !candidate || !plan.main || output.errors.length > 0) return output;

    const items = Array.from({ length: params.count }, (_, offset) => {
        const args = params.args.replaceAll("{seed}", String(params.seedStart + offset));
        return { id: args, args };
    });
    const generated = await engine.generate(await engine.program(generatorPath), group.constraints, group.name, items);
    const inputs: Array<{ id: string; inputHash: string; inputSize: number }> = [];
    for (const [args, result] of generated) {
        if ("error" in result) output.invalid.push({ args, message: result.error });
        else inputs.push({ id: args, inputHash: result.hash, inputSize: result.size });
    }

    let valid = inputs;
    if (plan.validator) {
        const results = await engine.validate(await engine.program(plan.validator.path), group.constraints, group.name, inputs);
        valid = inputs.filter((input) => {
            const message = results.get(input.id);
            if (message) output.invalid.push({ args: input.id, message });
            return !message;
        });
    }

    const limits = plan.manifest.limits;
    const answers = await engine.answers(await engine.program(plan.main.path), limits, valid);
    const tests = [];
    for (const input of valid) {
        const answer = answers.get(input.id);
        if (!answer || "error" in answer)
            output.failures.push({
                args: input.id,
                verdict: "MAIN",
                message: answer && "error" in answer ? answer.error : "no answer",
                inputHash: input.inputHash,
                inputSize: input.inputSize,
                timeMs: 0,
            });
        else tests.push({ ...input, answerHash: answer.hash });
    }

    const checkerProgram = plan.checker ? await engine.program(plan.checker.path) : undefined;
    const checker = checkerProgram && {
        language: checkerProgram.language,
        source: withPrelude(checkerProgram.source, checkerProgram.language, plan.manifest.constraints),
    };
    const runs = await engine.runSolution(
        await engine.program(candidate.path),
        checker,
        { type: plan.manifest.type, time_ms: limits.time_ms, memory_mb: limits.memory_mb },
        tests,
    );
    for (const test of tests) {
        const raw = runs.get(test.id);
        if (!raw) continue;
        const result = judge(raw, limits.time_ms);
        if (result.verdict === "AC") output.passed += 1;
        else
            output.failures.push({
                args: test.id,
                verdict: result.verdict,
                message: result.message,
                inputHash: test.inputHash,
                inputSize: test.inputSize,
                timeMs: result.timeMs,
            });
    }
    return output;
};
