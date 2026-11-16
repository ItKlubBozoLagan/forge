import { expect, test } from "@playwright/test";

import { build, createProblem, readFile, signIn } from "./helpers";

// Build tools line, clean rebuilds, test downloads, statement editing, the problems filter and
// workspace creation. One problem is shared, so the tests run in order.
test.describe.configure({ mode: "serial" });

const USER = "Mia";
let problemId: string;
let buildUrl: string;

test("shows the task type, checker and validator of a green build", async ({ page }) => {
    await signIn(page, USER);
    problemId = await createProblem(page, "Extras Sum");
    await build(page, "green");
    buildUrl = page.url();
    const tools = page.getByTestId("build-tools");
    await expect(tools).toContainText("validator.py");
    await expect(tools).toContainText("default comparison");
    await expect(tools).toContainText("batch");
    // a finished build cannot be cancelled
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
});

test("downloads the tests of a build as a zip", async ({ page }) => {
    await signIn(page, USER);
    await page.goto(buildUrl);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download tests" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});

test("rebuilds from scratch into a new green build", async ({ page }) => {
    await signIn(page, USER);
    await page.goto(buildUrl);
    await page.getByRole("button", { name: "Rebuild from scratch" }).click();
    await expect(page).not.toHaveURL(buildUrl);
    await expect(page).toHaveURL(/\/builds\/\d+/);
    await expect(page.getByTestId("build-status")).toHaveText(/green/i, { timeout: 200_000 });
    await expect(page.getByTestId("build-tools")).toContainText("validator.py");
});

test("edits the statement with a live preview", async ({ page }) => {
    const sentence = "Every pair is counted exactly once.";
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/statement`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByTestId("editor").locator(".cm-content");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(sentence);
    await expect(page.getByTestId("statement-unsaved")).toBeVisible();
    // rendered through the preview endpoint before anything is saved
    await expect(page.getByTestId("statement")).toContainText(sentence);
    expect(await readFile(page, problemId, "statement/en.md")).not.toContain(sentence);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("statement-unsaved")).toHaveCount(0);
    expect(await readFile(page, problemId, "statement/en.md")).toContain(sentence);
    await page.reload();
    await expect(page.getByTestId("statement")).toContainText(sentence);
});

test("has no horizontal page scroll at phone width while editing the statement", async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/statement`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("editor").locator(".cm-content")).toBeVisible();
    await expect(page.getByTestId("statement")).toBeVisible();
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
});

test("filters the problem list by title or name", async ({ page }) => {
    await signIn(page, USER);
    await createProblem(page, "Graph Walk");
    await page.goto("/");
    const filter = page.getByLabel("Filter problems");
    await filter.fill("extras");
    await expect(page.getByRole("link", { name: "Extras Sum" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Graph Walk" })).toHaveCount(0);
    // the name (slug) matches too
    await filter.fill("graph-walk");
    await expect(page.getByRole("link", { name: "Graph Walk" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Extras Sum" })).toHaveCount(0);
    await filter.fill("nothing like this");
    await expect(page.getByText(/no problems match/i)).toBeVisible();
});

test("creates a workspace and lands in it", async ({ page }) => {
    await signIn(page, USER);
    const before = page.url();
    await page.getByRole("button", { name: "New workspace" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Workspace name").fill("Mia practice");
    await dialog.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).not.toHaveURL(before);
    await expect(page).toHaveURL(/\/w\/\d+$/);
    await expect(page.getByText("No problems yet")).toBeVisible();
    await expect(page.locator("#workspace-switcher option:checked")).toHaveText("Mia practice");
});
