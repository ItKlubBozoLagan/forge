import { expect, Page, test } from "@playwright/test";

import { build, createProblem, readFile, signIn } from "./helpers";

// The Structure tab edits problem.yaml through forms; the file stays the source of truth.
test.describe.configure({ mode: "serial" });

let problemId: string;

const openStructure = async (page: Page) => {
    await page.goto(`/p/${problemId}/structure`);
    await expect(page.getByTestId("structure-groups")).toBeVisible();
};

const saveStructure = async (page: Page) => {
    const bar = page.getByTestId("structure-savebar");
    await expect(bar).toContainText("unsaved changes");
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar).toContainText("All changes saved");
};

test("adds a test to a group through the form and builds green", async ({ page }) => {
    await signIn(page, "Sara");
    problemId = await createProblem(page, "Structured Sums");
    await openStructure(page);

    const small = page.getByTestId("group-small");
    await small.getByLabel("Arguments", { exact: true }).fill("n=40 seed={i}");
    await small.getByLabel("Count", { exact: true }).fill("2");
    await small.getByLabel("Description", { exact: true }).fill("two small random tests");
    await small.getByRole("button", { name: "Add test" }).click();
    // the new line plans two tests after the four the template has
    await expect(small.getByTestId("test-small-3")).toContainText("small/5 to 6");
    await saveStructure(page);

    const manifest = await readFile(page, problemId, "problem.yaml");
    expect(manifest).toContain(
        '      - { gen: rand, args: "n=40 seed={i}", count: 2, desc: two small random tests }',
    );
    // comments and untouched lines survive
    expect(manifest).toContain("# IOI style: subtasks score all-or-nothing");
    expect(manifest).toContain("    depends: [small]");

    await build(page, "green");
    await expect(page.getByTestId("cell-solutions/main.cpp-small/6")).toContainText("AC");
});

test("turns the build red when an expectation cell no longer holds", async ({ page }) => {
    await signIn(page, "Sara");
    await openStructure(page);
    const cell = page.getByLabel("Expected result of solutions/overflow.cpp on full");
    await expect(cell).toHaveValue("WA");
    await cell.selectOption("AC");
    await saveStructure(page);
    expect(await readFile(page, problemId, "problem.yaml")).toContain(
        "{ path: solutions/overflow.cpp, expect: { samples: AC, small: AC, full: AC } }",
    );

    await build(page, "red");
    await expect(page.getByTestId("issues")).toContainText(
        'solutions/overflow.cpp is expected to be AC on "full" but got WA',
    );
});

test("lists a new solution file through the grid", async ({ page }) => {
    await signIn(page, "Sara");
    const created = await page.request.put(
        `/api/problems/${problemId}/file?path=${encodeURIComponent("solutions/zero.py")}`,
        {
            data: "print(0)\n",
            headers: { "Content-Type": "application/octet-stream", "X-Forge-Csrf": "1" },
        },
    );
    expect(created.ok()).toBe(true);

    await openStructure(page);
    await page.getByLabel("New solution").selectOption("solutions/zero.py");
    await page.getByRole("button", { name: "Add solution" }).click();
    await expect(page.getByTestId("solution-solutions/zero.py")).toBeVisible();
    await page.getByLabel("Expected result of solutions/zero.py on all groups").selectOption("WA");
    await expect(page.getByLabel("Expected result of solutions/zero.py on samples")).toHaveValue("WA");
    await saveStructure(page);
    expect(await readFile(page, problemId, "problem.yaml")).toContain(
        "  - { path: solutions/zero.py, expect: WA }",
    );
    await expect(page.getByTestId("structure-issues").filter({ hasText: "solutions/zero.py" })).toHaveCount(0);

    // usable on a phone: no horizontal page scroll
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("structure-groups")).toBeVisible();
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
});

test("keeps problem.yaml consistent when files are renamed or deleted", async ({ page }) => {
    await signIn(page, "Sara");
    await page.goto(`/p/${problemId}/files`);
    await page.getByRole("button", { name: "Rename tests/sample1.in" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("References to it in problem.yaml are updated too.");
    await dialog.getByLabel("New path").fill("tests/first.in");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByText("Renamed to tests/first.in; problem.yaml updated")).toBeVisible();

    let manifest = await readFile(page, problemId, "problem.yaml");
    expect(manifest).toContain("      - manual: tests/first.in\n");
    expect(manifest).not.toContain("sample1.in");

    await page.getByRole("button", { name: "Delete solutions/zero.py" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Deleted solutions/zero.py; problem.yaml updated")).toBeVisible();
    manifest = await readFile(page, problemId, "problem.yaml");
    expect(manifest).not.toContain("solutions/zero.py");

    await openStructure(page);
    await expect(page.getByLabel("File of test 1 of samples", { exact: true })).toHaveValue("tests/first.in");
    await expect(page.getByTestId("solution-solutions/zero.py")).toHaveCount(0);
});
