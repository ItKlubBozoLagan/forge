import { Constraints, Manifest } from "./manifest";

export type Sample = { input: string; output: string };

const scientific = (value: number): string => {
    if (!Number.isInteger(value) || Math.abs(value) < 10_000) return String(value);
    let exponent = 0;
    let mantissa = Math.abs(value);
    while (mantissa % 10 === 0) {
        mantissa /= 10;
        exponent += 1;
    }
    if (exponent < 3 || mantissa >= 100) return String(value);
    const sign = value < 0 ? "-" : "";
    return mantissa === 1 ? `${sign}10^{${exponent}}` : `${sign}${mantissa} \\cdot 10^{${exponent}}`;
};

/** A sample with no output (interactive tasks have none) shows its input only. */
const sampleMarkdown = (sample: Sample, index: number): string => {
    const input = `### Sample ${index + 1}\n\n**Input**\n\n\`\`\`\n${sample.input.trimEnd()}\n\`\`\``;
    return sample.output.trim() === "" ? input : `${input}\n\n**Output**\n\n\`\`\`\n${sample.output.trimEnd()}\n\`\`\``;
};

const samplesMarkdown = (samples: Sample[]): string => samples.map(sampleMarkdown).join("\n\n");

/**
 * Statements never hard-code a limit. `{{N.max}}` / `{{N.min}}` read the constraints from
 * problem.yaml (`{{N.max|raw}}` skips the 2·10^5 formatting), `{{group.small.N.max}}` reads
 * a group's effective constraint, `{{limits.time}}` / `{{limits.memory}}` the limits, and
 * `{{samples}}` is replaced by the sample tests (appended at the end when absent). `{{sample.2}}`
 * places one sample, so an explanation can follow each of them.
 */
export const renderStatement = (
    markdown: string,
    manifest: Manifest,
    groupConstraints: Record<string, Constraints>,
    samples: Sample[],
): { markdown: string; unresolved: string[] } => {
    const unresolved: string[] = [];
    let sawSamples = false;
    const rendered = markdown.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expression: string) => {
        const [path, filter] = expression.split("|").map((part) => part.trim());
        if (path === "samples") {
            sawSamples = true;
            return samplesMarkdown(samples);
        }
        const single = /^sample\.(\d+)$/.exec(path ?? "");
        if (single) {
            sawSamples = true;
            const index = Number(single[1]) - 1;
            // samples only exist after a build; until then the placeholder renders as nothing
            if (samples.length === 0) return "";
            const sample = samples[index];
            if (!sample) {
                unresolved.push(expression);
                return whole;
            }
            return sampleMarkdown(sample, index);
        }
        if (path === "limits.time") {
            const ms = manifest.limits.time_ms;
            return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
        }
        if (path === "limits.memory") return `${manifest.limits.memory_mb} MB`;
        const parts = (path ?? "").split(".");
        let constraints: Constraints | undefined = manifest.constraints;
        if (parts[0] === "group" && parts.length === 4) {
            constraints = groupConstraints[parts[1]!];
            parts.splice(0, 2);
        }
        const [name, side] = parts;
        const value = constraints?.[name ?? ""]?.[side as "min" | "max"];
        if (parts.length !== 2 || value === undefined) {
            unresolved.push(expression);
            return whole;
        }
        return filter === "raw" ? String(value) : scientific(value);
    });
    const markdownOut =
        sawSamples || samples.length === 0 ? rendered : `${rendered.trimEnd()}\n\n${samplesMarkdown(samples)}\n`;
    return { markdown: markdownOut, unresolved };
};
