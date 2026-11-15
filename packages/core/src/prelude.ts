import { Language } from "./languages";
import { Constraints } from "./manifest";

const isInteger = (value: number) => Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

/** Constant names injected for a constraint: `N: {min, max}` becomes `N_MIN` and `N_MAX`. */
export const constraintConstants = (constraints: Constraints): Array<[string, number]> => {
    const constants: Array<[string, number]> = [];
    for (const name of Object.keys(constraints).sort()) {
        const bound = constraints[name]!;
        if (bound.min !== undefined) constants.push([`${name}_MIN`, bound.min]);
        if (bound.max !== undefined) constants.push([`${name}_MAX`, bound.max]);
    }
    return constants;
};

/** Languages whose programs can receive the constraints prelude. */
export const PRELUDE_LANGUAGES: readonly Language[] = ["c", "cpp", "python"];

/**
 * The constraints are written once in problem.yaml and injected as constants into the
 * validator, generators and checker, so the statement, the validator and the tests cannot
 * drift apart. The prelude is prepended to the program source.
 */
export const withPrelude = (
    source: string,
    language: Language,
    constraints: Constraints,
    group?: string,
): string => {
    const constants = constraintConstants(constraints);
    if (language === "python") {
        const lines = constants.map(([name, value]) => `${name} = ${value}`);
        lines.push(`GROUP = ${JSON.stringify(group ?? "")}`);
        return `${lines.join("\n")}\n${source}`;
    }
    if (language === "c" || language === "cpp") {
        const lines = constants.map(([name, value]) =>
            isInteger(value)
                ? `static const long long ${name} = ${value}LL;`
                : `static const double ${name} = ${value};`,
        );
        lines.push(`static const char FORGE_GROUP[] = ${JSON.stringify(group ?? "")};`);
        // keeps compiler diagnostics pointing at the author's own line numbers
        lines.push("#line 1");
        return `${lines.join("\n")}\n${source}`;
    }
    return source;
};
