import { describe, expect, it } from "vitest";

import { createIgnore, isSyncable } from "../src/ignore";

describe("createIgnore", () => {
    it("always ignores dotfiles and node_modules", () => {
        const ignored = createIgnore();
        expect(ignored(".forge/state.json")).toBe(true);
        expect(ignored(".forgeignore")).toBe(true);
        expect(ignored("sol/.hidden")).toBe(true);
        expect(ignored("node_modules/x/y.js")).toBe(true);
        expect(ignored("sol/main.cpp")).toBe(false);
    });
    it("matches basename patterns at any depth", () => {
        const ignored = createIgnore("*.o\n# comment\n\n");
        expect(ignored("a.o")).toBe(true);
        expect(ignored("sol/deep/a.o")).toBe(true);
        expect(ignored("a.cpp")).toBe(false);
    });
    it("anchors patterns that contain a slash", () => {
        const ignored = createIgnore("/build\nsol/*.tmp");
        expect(ignored("build/out.txt")).toBe(true);
        expect(ignored("sub/build/out.txt")).toBe(false);
        expect(ignored("sol/a.tmp")).toBe(true);
        expect(ignored("sol/x/a.tmp")).toBe(false);
    });
    it("supports ** across directories", () => {
        const ignored = createIgnore("tests/**/*.out\ngen/**");
        expect(ignored("tests/a.out")).toBe(true);
        expect(ignored("tests/x/y/a.out")).toBe(true);
        expect(ignored("tests/a.in")).toBe(false);
        expect(ignored("gen/anything/else")).toBe(true);
    });
    it("directory-only patterns do not match files of that name", () => {
        const ignored = createIgnore("out/");
        expect(ignored("out", true)).toBe(true);
        expect(ignored("out/a.txt")).toBe(true);
        expect(ignored("out")).toBe(false);
    });
    it("treats regex characters literally", () => {
        const ignored = createIgnore("a+b.txt");
        expect(ignored("a+b.txt")).toBe(true);
        expect(ignored("aab.txt")).toBe(false);
    });
});

describe("isSyncable", () => {
    it("accepts plain paths and rejects odd ones", () => {
        expect(isSyncable("solutions/main.cpp")).toBe(true);
        expect(isSyncable("a b.txt")).toBe(false);
        expect(isSyncable("é.txt")).toBe(false);
        expect(isSyncable("../x")).toBe(false);
        expect(isSyncable("/etc/passwd")).toBe(false);
        expect(isSyncable("a//b")).toBe(false);
    });
});
