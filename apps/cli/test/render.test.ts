import { describe, expect, it } from "vitest";

import { describeTools } from "../src/render";

describe("describeTools", () => {
    it("names the task type, checker and validator", () => {
        expect(describeTools({ type: "interactive", checker: "check.cpp", validator: "val.cpp" })).toBe(
            "Judging: interactive task, checker check.cpp, validator val.cpp",
        );
    });
    it("falls back to the default comparison and no validator", () => {
        expect(describeTools({})).toBe("Judging: batch task, checker default comparison, validator none");
        expect(describeTools({ type: "batch", checker: null, validator: null })).toBe(
            "Judging: batch task, checker default comparison, validator none",
        );
    });
});
