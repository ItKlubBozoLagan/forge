import { describe, expect, it } from "vitest";

import { diffLocal, diffRemote, findConflicts, planPull, planPush } from "../src/sync";

const base = { a: "1", b: "2", c: "3" };

describe("diffLocal / diffRemote", () => {
    it("classifies added, modified, deleted", () => {
        const current = { a: "1", b: "X", d: "4" };
        const expected = { added: ["d"], modified: ["b"], deleted: ["c"] };
        expect(diffLocal(base, current)).toEqual(expected);
        expect(diffRemote(base, current)).toEqual(expected);
    });
    it("reports nothing when unchanged", () => {
        expect(diffLocal(base, { ...base })).toEqual({ added: [], modified: [], deleted: [] });
    });
});

describe("planPull", () => {
    it("downloads remote additions and modifications, deletes remote deletions", () => {
        const remote = { a: "1", b: "X", d: "4" };
        const plan = planPull(base, { ...base }, remote);
        expect(plan.download).toEqual(["b", "d"]);
        expect(plan.deleteLocal).toEqual(["c"]);
        expect(plan.conflicts).toEqual([]);
        expect(plan.base).toEqual(remote);
    });
    it("keeps local-only changes and their old base", () => {
        const plan = planPull(base, { a: "L", b: "2" }, { ...base });
        expect(plan.download).toEqual([]);
        expect(plan.deleteLocal).toEqual([]);
        expect(plan.conflicts).toEqual([]);
        expect(plan.base).toEqual(base);
    });
    it("is not a conflict when both sides made the same change", () => {
        const plan = planPull(base, { a: "S", b: "2" }, { a: "S", b: "2" });
        expect(plan.conflicts).toEqual([]);
        expect(plan.download).toEqual([]);
        expect(plan.base).toEqual({ a: "S", b: "2" });
        expect(findConflicts(base, { a: "S" }, { a: "S" })).toEqual([]);
    });
    it("is a conflict when both sides changed differently, base untouched", () => {
        const plan = planPull(base, { ...base, a: "L" }, { ...base, a: "R" });
        expect(plan.conflicts).toEqual([{ path: "a", remoteHash: "R" }]);
        expect(plan.download).toEqual([]);
        expect(plan.base.a).toBe("1");
    });
    it("treats two different additions as a conflict", () => {
        const plan = planPull({}, { n: "L" }, { n: "R" });
        expect(plan.conflicts).toEqual([{ path: "n", remoteHash: "R" }]);
    });
    it("delete (local) vs modify (remote) is a conflict", () => {
        const plan = planPull(base, { b: "2", c: "3" }, { ...base, a: "R" });
        expect(plan.conflicts).toEqual([{ path: "a", remoteHash: "R" }]);
    });
    it("modify (local) vs delete (remote) is a conflict", () => {
        const plan = planPull(base, { ...base, a: "L" }, { b: "2", c: "3" });
        expect(plan.conflicts).toEqual([{ path: "a", remoteHash: undefined }]);
        expect(plan.deleteLocal).toEqual([]);
    });
    it("both deleted is fine and drops the base entry", () => {
        const plan = planPull(base, { b: "2", c: "3" }, { b: "2", c: "3" });
        expect(plan.conflicts).toEqual([]);
        expect(plan.base).toEqual({ b: "2", c: "3" });
    });
});

describe("planPush", () => {
    it("sends added, modified and deleted with their bases", () => {
        const plan = planPush(base, { a: "1", b: "X", d: "4" });
        expect(plan.changes).toEqual([
            { path: "b", base: "2", hash: "X" },
            { path: "d", base: null, hash: "4" },
            { path: "c", base: "3", hash: null },
        ].sort((x, y) => (x.path < y.path ? -1 : 1)));
        expect(plan.upload).toEqual(["b", "d"]);
        expect(plan.base).toEqual({ a: "1", b: "X", d: "4" });
    });
    it("does nothing when unchanged", () => {
        const plan = planPush(base, { ...base });
        expect(plan.changes).toEqual([]);
        expect(plan.upload).toEqual([]);
    });
    it("only adopts paths the server already has with the same content", () => {
        const plan = planPush(base, { a: "S", b: "2", c: "3" }, { a: "S", b: "2", c: "3" });
        expect(plan.changes).toEqual([]);
        expect(plan.adopt).toEqual(["a"]);
        expect(plan.base.a).toBe("S");
    });
});
