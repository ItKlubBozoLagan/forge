import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

import { build, createProblem, openFile, readFile, replaceEditorContent, signIn } from "./helpers";

// The tests tell one story in order: an author prepares a problem, a tester tests it blind,
// and the problem is released in a problem set.
test.describe.configure({ mode: "serial" });

let problemId: string;

test("sends visitors to the login page and back to where they were going", async ({ page }) => {
    await page.goto("/tokens");
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("Name").fill("Ana");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/tokens/);
});

test("creates a problem from a template and builds it green", async ({ page }) => {
    await signIn(page, "Ana");
    problemId = await createProblem(page, "Pair Sum");
    await expect(page.getByTestId("file-problem.yaml")).toBeVisible();
    await expect(page.getByTestId("file-solutions/main.cpp")).toBeVisible();

    await build(page, "green");
    const matrix = page.getByTestId("matrix");
    await expect(matrix).toBeVisible();
    await expect(page.getByTestId("cell-solutions/main.cpp-full/1")).toContainText("AC");
    await expect(page.getByTestId("cell-solutions/brute.cpp-full/1")).toContainText("TLE");
    await expect(page.getByTestId("cell-solutions/overflow.cpp-full/3")).toContainText("WA");
    await expect(page.getByTestId("cell-solutions/overflow.cpp-small/1")).toContainText("AC");
    // calibration and kill matrix are part of the report
    await expect(page.getByText(/headroom/i).first()).toBeVisible();
    await expect(page.getByText(/kill matrix/i).first()).toBeVisible();
});

test("shows a test's input and answer", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/builds`);
    await page.getByRole("button", { name: "samples/1" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("5 6");
    await expect(dialog).toContainText("1 5 3 3 2");
});

test("shows what a failing solution printed on a test", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/builds`);
    await page.getByRole("button", { name: "full/3" }).first().click();
    const output = page.getByRole("dialog").getByTestId("solution-output");
    // the drawer opens on the first solution failing this test: the brute force, killed for time
    await expect(output).toContainText("Output of solutions/brute.cpp");
    await expect(output).toContainText("No output was kept");
    await page.getByRole("dialog").getByRole("button", { name: "solutions/overflow.cpp" }).click();
    await expect(output).toContainText("Output of solutions/overflow.cpp");
    await expect(output.locator("pre").first()).toHaveText(/^-?\d+\s*$/);
    const wrong = (await output.locator("pre").first().textContent())!.trim();
    await page.getByRole("dialog").getByRole("button", { name: "solutions/main.cpp" }).click();
    await expect(output).toContainText("Output of solutions/main.cpp");
    await expect(output.locator("pre").first()).not.toHaveText(wrong);
});

test("validates problem.yaml while it is edited", async ({ page }) => {
    await signIn(page, "Ana");
    await openFile(page, problemId, "problem.yaml");
    const manifest = await readFile(page, problemId, "problem.yaml");
    await replaceEditorContent(page, manifest.replace('gen: rand, args: "mode=equal seed=3"', 'gen: missing, args: "mode=equal seed=3"'));
    await expect(page.getByText(/unknown generator/i).first()).toBeVisible();
    await replaceEditorContent(page, manifest);
    await expect(page.getByText(/unknown generator/i)).toHaveCount(0);
});

test("turns red when a solution stops behaving as declared", async ({ page }) => {
    await signIn(page, "Ana");
    await openFile(page, problemId, "problem.yaml");
    const manifest = await readFile(page, problemId, "problem.yaml");
    await replaceEditorContent(page, manifest.replace("small: AC, full: WA", "small: AC, full: AC"));
    await expect.poll(() => readFile(page, problemId, "problem.yaml")).toContain("overflow.cpp, expect: { samples: AC, small: AC, full: AC }");

    await build(page, "red");
    await expect(page.getByTestId("issues")).toContainText('solutions/overflow.cpp is expected to be AC on "full" but got WA');

    await openFile(page, problemId, "problem.yaml");
    await replaceEditorContent(page, manifest);
    await expect.poll(() => readFile(page, problemId, "problem.yaml")).toBe(manifest);
});

test("renders the statement with constraints and samples from the package", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/statement`);
    await expect(page.getByRole("heading", { name: "Pair Sum" }).last()).toBeVisible();
    await expect(page.locator(".katex").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sample 1" })).toBeVisible();
    // the sample output is the main solution's answer
    await expect(page.locator("pre").filter({ hasText: /^2\s*$/ })).toBeVisible();
    await expect(page.getByText("{{")).toHaveCount(0);
});

test("commits a revision, which is built on its own", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/files`);
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message").fill("First complete version");
    await dialog.getByRole("button", { name: /commit/i }).click();
    await page.goto(`/p/${problemId}/revisions`);
    const row = page.getByRole("row").filter({ hasText: "First complete version" });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/green/i, { timeout: 120_000 });
});

test("finds a counterexample by stress testing and adds it to the tests", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/stress`);
    await page.getByLabel("Solution").selectOption("solutions/overflow.cpp");
    await page.getByLabel("Group").selectOption("full");
    await page.getByLabel("Arguments").fill("mode=equal seed={seed}");
    await page.getByLabel("Count").fill("2");
    await page.getByLabel("First seed").fill("70");
    await page.getByRole("button", { name: /run|start/i }).click();
    const failure = page.getByRole("row").filter({ hasText: "mode=equal seed=70" });
    await expect(failure).toContainText("WA", { timeout: 120_000 });
    await failure.getByRole("button", { name: "Add to tests" }).click();
    await expect.poll(() => readFile(page, problemId, "problem.yaml")).toContain("mode=equal seed=70");
});

test("runs a solution that is not part of the package", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/invocations`);
    await page.getByLabel("Name").fill("always-zero");
    await page.getByLabel("Language").selectOption("python");
    await page.getByTestId("editor").locator(".cm-content").click();
    await page.keyboard.insertText("print(0)\n");
    await page.getByRole("button", { name: /^run/i }).click();
    const result = page.getByRole("row").filter({ hasText: "small" });
    await expect(result.first()).toContainText("WA", { timeout: 120_000 });
});

test("discusses the problem in review threads", async ({ page }) => {
    await signIn(page, "Ana");
    await page.goto(`/p/${problemId}/review`);
    await page.getByRole("textbox").first().fill("Should the second subtask allow N = 1?");
    await page.getByRole("button", { name: /start thread|comment|post/i }).first().click();
    await expect(page.getByText("Should the second subtask allow N = 1?")).toBeVisible();
    await page.getByPlaceholder(/reply/i).first().fill("No, the statement says N is at least 2.");
    await page.getByRole("button", { name: /^reply/i }).first().click();
    await expect(page.getByText("No, the statement says N is at least 2.")).toBeVisible();
    await page.getByRole("button", { name: /^resolve/i }).first().click();
    // resolved threads are collapsed out of the way and can be reopened
    await expect(page.getByText("Resolved (1)")).toBeVisible();
    await page.locator("summary").getByText("Should the second subtask allow N = 1?").click();
    await expect(page.getByRole("button", { name: /reopen/i }).first()).toBeVisible();
});

test("lets a blind tester test the problem without seeing its files", async ({ page, browser }) => {
    // Bruno signs in once so he exists, then Ana adds him to the workspace and the problem
    const brunoContext = await browser.newContext();
    const bruno = await brunoContext.newPage();
    await signIn(bruno, "Bruno");

    await signIn(page, "Ana");
    const me = await (await page.request.get("/api/me")).json();
    const workspaceId = me.workspaces[0].id;
    await page.goto(`/w/${workspaceId}/settings`);
    await page.getByLabel(/email/i).fill("bruno@dev.local");
    await page.getByRole("button", { name: /add member|^add/i }).click();
    await expect(page.getByRole("row").filter({ hasText: "bruno@dev.local" })).toBeVisible();

    await page.goto(`/p/${problemId}/access`);
    await page.getByLabel("Workspace member").selectOption({ label: "Bruno (bruno@dev.local)" });
    await page.getByLabel("Role", { exact: true }).selectOption("tester");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByLabel("Role of Bruno")).toHaveValue("tester");

    await bruno.goto(`/w/${workspaceId}`);
    await bruno.getByRole("link", { name: /Pair Sum/ }).click();
    await expect(bruno.getByRole("heading", { name: "Sample 1" })).toBeVisible();
    for (const hidden of ["Files", "Builds", "Revisions", "Stress", "Access & settings"])
        await expect(bruno.getByRole("tab", { name: hidden }).or(bruno.getByRole("link", { name: hidden, exact: true }))).toHaveCount(0);
    // the API refuses too, not only the navigation
    expect((await bruno.request.get(`/api/problems/${problemId}/tree`)).status()).toBe(403);

    await bruno.goto(`/p/${problemId}/invocations`);
    await bruno.getByLabel("Name").fill("bruno-try");
    await bruno.getByLabel("Language").selectOption("python");
    await bruno.getByTestId("editor").locator(".cm-content").click();
    await bruno.keyboard.insertText("n, k = map(int, input().split())\na = list(map(int, input().split()))\nprint(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == k))\n");
    await bruno.getByRole("button", { name: /^run/i }).click();
    await expect(bruno.getByRole("row").filter({ hasText: "small" }).first()).toContainText("AC", { timeout: 180_000 });
    await expect(bruno.getByRole("row").filter({ hasText: "full" }).first()).toContainText("TLE");
    await brunoContext.close();
});

test("pins a revision in a problem set and exports the judge bundle", async ({ page }) => {
    await signIn(page, "Ana");
    const me = await (await page.request.get("/api/me")).json();
    await page.goto(`/w/${me.workspaces[0].id}/sets`);
    await page.getByLabel("New set name").fill("Round 1");
    await page.getByRole("button", { name: "Create set" }).click();
    await expect(page).toHaveURL(/\/sets\/\d+/);
    await page.getByRole("button", { name: /add problem/i }).first().click();
    await page.getByLabel("Label of row 1").fill("A");
    await page.getByLabel("Problem of row 1").selectOption({ label: "Pair Sum (pair-sum)" });
    await page.getByLabel("Revision of row 1").selectOption({ index: 1 });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(page.getByRole("row").filter({ hasText: "Pair Sum" })).toContainText(/green/i);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export judge bundle" }).click();
    expect((await download).suggestedFilename()).toMatch(/Round-1.*\.zip$/);
});

test("authorises the CLI through the browser", async ({ page }) => {
    // stands in for the CLI's loopback server
    let received: URL | undefined;
    const cli = createServer((req, res) => {
        received = new URL(req.url!, "http://127.0.0.1");
        res.writeHead(200, { "content-type": "text/html" }).end("<h1>You can close this tab</h1>");
    });
    await new Promise<void>((resolve) => cli.listen(0, "127.0.0.1", resolve));
    const port = (cli.address() as AddressInfo).port;
    try {
        await signIn(page, "Ana");
        await page.goto(`/cli-login?port=${port}&state=abc123`);
        await page.getByRole("button", { name: "Authorize" }).click();
        await expect(page.getByText("You can close this tab")).toBeVisible();
        expect(received?.pathname).toBe("/callback");
        expect(received?.searchParams.get("state")).toBe("abc123");
        const token = received!.searchParams.get("token")!;
        const me = await page.request.fetch("/api/me", { headers: { authorization: `Bearer ${token}` } });
        expect((await me.json()).user.name).toBe("Ana");

        await page.goto("/cli-login?port=80&state=abc123");
        await expect(page.getByRole("button", { name: "Authorize" })).toHaveCount(0);
    } finally {
        cli.close();
    }
});

test("stays usable on a phone-sized screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "Ana");
    for (const path of ["", `/p/${problemId}/statement`, `/p/${problemId}/builds`]) {
        if (path) await page.goto(path);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `horizontal overflow on ${path || "the problems page"}`).toBeLessThanOrEqual(1);
    }
});

test("shows what the validator said about every test", async ({ page }) => {
    await signIn(page, "Ana");
    const id = await createProblem(page, "Checked Tests");
    await build(page, "green");
    const summary = page.getByTestId("validation-summary");
    await expect(summary).toContainText("all valid");
    await expect(summary).toContainText("validator.py");
    // a test of "small" must also satisfy "full", which depends on it
    await expect(page.getByTestId("test-row-small/1")).toContainText("for small, full");

    // 2000 numbers in a group that allows at most 1000
    const manifest = await readFile(page, id, "problem.yaml");
    await openFile(page, id, "problem.yaml");
    await replaceEditorContent(page, manifest.replace('args: "n=1000 mode=equal seed=9"', 'args: "n=2000 mode=equal seed=9"'));
    await expect.poll(() => readFile(page, id, "problem.yaml")).toContain("n=2000");
    await build(page, "red");
    await expect(page.getByTestId("validation-summary")).toContainText("1 rejected");
    const row = page.getByTestId("test-row-small/4");
    await expect(row).toContainText("invalid for small");
    await expect(row).toContainText("N=2000");

    // without a validator the report says so instead of showing nothing
    await openFile(page, id, "problem.yaml");
    await replaceEditorContent(page, manifest.replace("validator: validator.py\n", ""));
    await expect.poll(() => readFile(page, id, "problem.yaml")).not.toContain("validator:");
    await build(page, "green");
    await expect(page.getByTestId("validation-summary")).toContainText("no validator");
    await expect(page.getByTestId("test-row-small/1")).toContainText("not validated");
});

test("builds an interactive task", async ({ page }) => {
    await signIn(page, "Ana");
    await createProblem(page, "Guess It", "interactive");
    await expect(page.getByTestId("file-interactor.py")).toBeVisible();
    await build(page, "green");
    await expect(page.getByTestId("cell-solutions/binary.py-secret/2")).toContainText("AC");
    await expect(page.getByTestId("cell-solutions/linear.py-secret/1")).toContainText("AC");
    await expect(page.getByTestId("cell-solutions/linear.py-secret/2")).toContainText(/WA|TLE/);
});

test("builds an output-only task whose solutions are output files", async ({ page }) => {
    await signIn(page, "Ana");
    const id = await createProblem(page, "Pack It", "output-only");
    await expect(page.getByTestId("file-solutions/greedy/tests/1.out")).toBeVisible();
    await build(page, "green");
    await expect(page.getByTestId("cell-solutions/main.py-tests/1")).toContainText("AC");
    await expect(page.getByTestId("cell-solutions/greedy-tests/1")).toContainText("PA");
    await expect(page.getByTestId("cell-solutions/unfinished-tests/1")).toContainText("AC");
    await expect(page.getByTestId("cell-solutions/unfinished-tests/2")).toContainText("WA");
    await expect(page.getByText(/no\s+time limit to calibrate/i)).toBeVisible();
    await expect(page.getByTestId("validation-summary")).toContainText("all valid");

    // an invalid output file is a wrong answer, and the build says the expectation broke
    await openFile(page, id, "solutions/greedy/tests/1.out");
    await replaceEditorContent(page, "2\n1 1\n");
    await expect.poll(() => readFile(page, id, "solutions/greedy/tests/1.out")).toContain("1 1");
    await build(page, "red");
    await expect(page.getByTestId("cell-solutions/greedy-tests/1")).toContainText("WA");
    await expect(page.getByTestId("issues")).toContainText("solutions/greedy is expected to be PA");
});

test("retitles and deletes a problem from its settings", async ({ page }) => {
    await signIn(page, "Ana");
    const id = await createProblem(page, "Throwaway");
    await page.goto(`/p/${id}/access`);
    await page.getByLabel("Title").fill("Throwaway Renamed");
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(page.getByRole("heading", { name: "Throwaway Renamed" })).toBeVisible();

    await page.getByRole("button", { name: "Delete problem" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/\d+$/);
    await expect(page.getByRole("button", { name: "New problem" }).first()).toBeVisible();
    await expect(page.getByText("Throwaway Renamed")).toHaveCount(0);
});

test("imports a Polygon package and builds it with its testlib tools", async ({ page }) => {
    const text = (value: string) => new Uint8Array(Buffer.from(value));
    const archive = zipSync({
        "problem.xml": text(`<?xml version="1.0" encoding="utf-8"?>
<problem revision="3" short-name="triple-it">
    <names><name language="english" value="Triple It"/></names>
    <judging>
        <testset name="tests">
            <time-limit>2000</time-limit>
            <memory-limit>268435456</memory-limit>
            <input-path-pattern>tests/%02d</input-path-pattern>
            <tests>
                <test method="manual" sample="true"/>
                <test cmd="gen 100 1" method="generated"/>
                <test cmd="gone 1" method="generated"/>
            </tests>
        </testset>
    </judging>
    <files><executables><executable><source path="files/gen.cpp" type="cpp.g++17"/></executable></executables></files>
    <assets>
        <checker name="std::ncmp.cpp" type="testlib"><source path="files/check.cpp" type="cpp.g++17"/></checker>
        <solutions>
            <solution tag="main"><source path="solutions/sol.py" type="python.3"/></solution>
            <solution tag="wrong-answer"><source path="solutions/wrong.py" type="python.3"/></solution>
        </solutions>
    </assets>
</problem>`),
        "files/gen.cpp": text(`#include "testlib.h"\n#include <cstdlib>\nint main(int argc, char* argv[]) {\n    registerGen(argc, argv, 1);\n    println(rnd.next(2, atoi(argv[1])));\n}\n`),
        "files/check.cpp": text(`#include "testlib.h"\nint main(int argc, char* argv[]) {\n    registerTestlibCmd(argc, argv);\n    int expected = ans.readInt(), found = ouf.readInt();\n    if (expected != found) quitf(_wa, "expected %d, found %d", expected, found);\n    quitf(_ok, "ok");\n}\n`),
        "solutions/sol.py": text("print(int(input()) * 3)\n"),
        "solutions/wrong.py": text("print(int(input()) + 2)\n"),
        "tests/01": text("1\n"),
        "statements/english/problem-properties.json": text(JSON.stringify({ name: "Triple It", legend: "Print \\textbf{three times} $n$.", input: "One integer.", output: "One integer." })),
    });

    await signIn(page, "Ana");
    await page.getByTestId("polygon-file").first().setInputFiles({ name: "triple-it.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
    // the generator of the third test is not in the package, and the import says so
    await expect(page.getByTestId("import-notes")).toContainText('"gone 1"');
    await page.getByRole("button", { name: "Open problem" }).click();
    await expect(page).toHaveURL(/\/p\/\d+\//);
    await expect(page.getByTestId("file-checker.cpp")).toBeVisible();
    await expect(page.getByTestId("file-generators/gen.cpp")).toBeVisible();

    await build(page, "green");
    await expect(page.getByTestId("build-tools")).toContainText("checker.cpp");
    await expect(page.getByTestId("cell-solutions/sol.py-tests/1")).toContainText("AC");
    await expect(page.getByTestId("cell-solutions/wrong.py-tests/1")).toContainText("WA");
});
