import { expect, Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

import { createProblem, openFile, readFile, replaceEditorContent, signIn } from "./helpers";

// Bulk file handling, browsing and comparing revisions, and review threads anchored to lines.
// The tests build on each other, on one problem of their own.
test.describe.configure({ mode: "serial" });

const USER = "Luka";
let problemId: string;
let firstRevision: string;

const openUpload = async (page: Page) => {
    await page.getByRole("button", { name: "Upload files", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Upload files" })).toBeVisible();
    return dialog;
};

const commit = async (page: Page, message: string) => {
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Message").fill(message);
    await dialog.getByRole("button", { name: "Commit", exact: true }).click();
    await expect(page.getByText(/Committed revision \d+/)).toBeVisible();
};

const noHorizontalScroll = async (page: Page, what: string) => {
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `horizontal overflow on ${what}`).toBeLessThanOrEqual(1);
};

test("uploads several files at once into a folder and reports the ones it cannot take", async ({
    page,
}) => {
    await signIn(page, USER);
    problemId = await createProblem(page, "Bulk Files", "ioi");
    await page.goto(`/p/${problemId}/files`);
    const dialog = await openUpload(page);
    await dialog.getByTestId("upload-files-input").setInputFiles([
        { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("alpha\n") },
        {
            name: "b.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("line one\nline two\nline three\n"),
        },
        { name: "bad name.txt", mimeType: "text/plain", buffer: Buffer.from("x\n") },
    ]);
    await dialog.getByLabel("Target folder").fill("extra");
    const plan = dialog.getByTestId("upload-plan");
    await expect(plan).toContainText("extra/a.txt");
    await expect(plan).toContainText("extra/b.txt");
    await expect(dialog.getByTestId("upload-summary")).toContainText("2 new, 1 skipped");
    await dialog.getByRole("button", { name: "Upload 2 files" }).click();

    await expect(dialog.getByTestId("upload-result")).toContainText("Uploaded 2 files");
    await expect(dialog.getByTestId("upload-failures")).toContainText("extra/bad name.txt");
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("file-extra/a.txt")).toBeVisible();
    await expect(page.getByTestId("file-extra/b.txt")).toBeVisible();
    expect(await readFile(page, problemId, "extra/a.txt")).toBe("alpha\n");

    // files dropped on a folder of the tree go into that folder
    const transfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(new File(["dropped\n"], "c.txt", { type: "text/plain" }));
        return data;
    });
    const folder = page.locator('[data-folder="extra"]');
    await folder.dispatchEvent("dragenter", { dataTransfer: transfer });
    await folder.dispatchEvent("dragover", { dataTransfer: transfer });
    await folder.dispatchEvent("drop", { dataTransfer: transfer });
    const dropped = page.getByRole("dialog");
    await expect(dropped.getByLabel("Target folder")).toHaveValue("extra");
    await expect(dropped.getByTestId("upload-plan")).toContainText("extra/c.txt");
    await dropped.getByRole("button", { name: "Upload 1 file" }).click();
    await expect(dropped.getByTestId("upload-result")).toContainText("Uploaded 1 file");
    await dropped.getByRole("button", { name: "Close", exact: true }).last().click();
    expect(await readFile(page, problemId, "extra/c.txt")).toBe("dropped\n");
});

test("unpacks a zip in the browser and shows what it creates and overwrites", async ({ page }) => {
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/files`);
    const zip = zipSync({
        "pack/extra/a.txt": strToU8("alpha from the zip\n"),
        "pack/data/x1.in": strToU8("1 2\n"),
        "pack/data/x2.in": strToU8("3 4\n"),
    });
    const dialog = await openUpload(page);
    await dialog.getByTestId("upload-zip-input").setInputFiles({
        name: "pack.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(zip),
    });
    await expect(dialog.getByLabel(/Leave out the archive's top folder/)).toBeChecked();
    const plan = dialog.getByTestId("upload-plan");
    await expect(plan.getByRole("listitem").filter({ hasText: "extra/a.txt" })).toContainText(
        "overwrite",
    );
    await expect(plan.getByRole("listitem").filter({ hasText: "data/x1.in" })).toContainText("new");
    await expect(dialog.getByTestId("upload-summary")).toContainText("2 new, 1 overwritten");
    await dialog.getByRole("button", { name: "Upload 3 files" }).click();
    await expect(dialog.getByTestId("upload-result")).toContainText("Uploaded 3 files");
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();

    await expect(page.getByTestId("file-data/x2.in")).toBeVisible();
    expect(await readFile(page, problemId, "extra/a.txt")).toBe("alpha from the zip\n");
    expect(await readFile(page, problemId, "data/x1.in")).toBe("1 2\n");
});

test("deletes a whole folder after confirming how many files it holds", async ({ page }) => {
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/files`);
    await page.getByRole("button", { name: "Delete folder data" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("2 files");
    await expect(dialog).toContainText("data/x1.in");
    await dialog.getByRole("button", { name: "Delete 2 files" }).click();
    await expect(page.getByTestId("file-data/x1.in")).toHaveCount(0);
    await expect(page.getByTestId("file-data/x2.in")).toHaveCount(0);
    const tree = await page.request.get(`/api/problems/${problemId}/tree`);
    const paths = ((await tree.json()).files as Array<{ path: string }>).map((f) => f.path);
    expect(paths.filter((path) => path.startsWith("data/"))).toEqual([]);
});

test("shows the files and the line diff that changed between two revisions", async ({ page }) => {
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/files`);
    await commit(page, "Add extra files");

    await openFile(page, problemId, "extra/b.txt");
    await replaceEditorContent(page, "line one\nline two changed\nline three\n");
    await expect
        .poll(() => readFile(page, problemId, "extra/b.txt"))
        .toBe("line one\nline two changed\nline three\n");

    // the working copy against the latest revision, from the Files tab
    await page.getByRole("link", { name: "Changes since revision 1" }).click();
    await expect(page.getByTestId("change-extra/b.txt")).toContainText("changed");

    await commit(page, "Reword line two");
    await page.goto(`/p/${problemId}/revisions`);
    await page.getByRole("link", { name: "Changes in revision 2" }).click();
    await expect(
        page.getByRole("heading", { name: /from revision 1 to revision 2/ }),
    ).toBeVisible();
    await expect(page.getByTestId("change-summary")).toHaveText("1 changed");
    await page.getByTestId("change-extra/b.txt").click();
    const diff = page.getByTestId("line-diff");
    const removed = diff.locator('tr[data-kind="del"]');
    const added = diff.locator('tr[data-kind="add"]');
    await expect(removed).toHaveCount(1);
    await expect(added).toHaveCount(1);
    await expect(removed).toContainText("-");
    await expect(removed).toContainText("line two");
    await expect(added).toContainText("+");
    await expect(added).toContainText("line two changed");
    await expect(diff.locator('tr[data-kind="same"]').first()).toContainText("line one");
});

test("opens an old revision read-only, with its own package download", async ({ page }) => {
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/revisions`);
    await page.getByRole("link", { name: "Browse revision 1" }).click();
    await expect(page).toHaveURL(/\/revisions\/\d+$/);
    firstRevision = page.url().match(/\/revisions\/(\d+)$/)![1]!;
    await expect(page.getByRole("heading", { name: "Revision 1" })).toBeVisible();
    await expect(page.getByText("read-only").first()).toBeVisible();

    await page.getByTestId("file-extra/b.txt").click();
    const content = page.getByTestId("editor").locator(".cm-content");
    await expect(content).toContainText("line two");
    await expect(content).not.toContainText("changed");
    await expect(content).toHaveAttribute("contenteditable", "false");

    const archive = `/api/problems/${problemId}/archive?revision=${firstRevision}`;
    const request = page.waitForRequest((r) => r.url().includes("/archive"));
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download package" }).click();
    expect(new URL((await request).url()).pathname + new URL((await request).url()).search).toBe(
        archive,
    );
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);
});

test("starts a thread from a line in the editor and reaches it from the Review tab", async ({
    page,
}) => {
    await signIn(page, USER);
    await openFile(page, problemId, "extra/b.txt");
    await page.getByTestId("editor").locator(".cm-line").nth(1).click();
    await page.getByRole("button", { name: "Comment on line 2" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("extra/b.txt in the working copy");
    await dialog.getByLabel("Comment").fill("Is the second line right?");
    await dialog.getByRole("button", { name: "Start thread" }).click();
    await expect(page.getByTestId("comment-marker-2")).toBeVisible();
    await expect(page.getByLabel("Review threads in this file")).toContainText(
        "Is the second line right?",
    );

    // a thread on a revision, started by clicking the comment gutter of the read-only viewer
    await page.goto(`/p/${problemId}/revisions/${firstRevision}?path=extra/b.txt`);
    await expect(page.getByTestId("editor").locator(".cm-content")).toContainText("line three");
    await page.locator(".cm-comment-gutter .cm-gutterElement").nth(3).click();
    const revisionDialog = page.getByRole("dialog");
    await expect(revisionDialog.getByRole("heading")).toHaveText("Comment on line 3");
    await expect(revisionDialog).toContainText("in revision 1");
    await revisionDialog.getByLabel("Comment").fill("Line three in the first version");
    await revisionDialog.getByRole("button", { name: "Start thread" }).click();
    await expect(page.getByTestId("comment-marker-3")).toBeVisible();

    // the Review tab links each anchored thread to its file and line
    await page.goto(`/p/${problemId}/review`);
    await page.getByRole("link", { name: "extra/b.txt:2" }).click();
    await expect(page).toHaveURL(/\/files\?path=extra%2Fb\.txt&line=2/);
    await expect(page.locator(".cm-focus-line")).toHaveText("line two changed");
    await expect(page.getByRole("button", { name: "Comment on line 2" })).toBeVisible();

    await page.goto(`/p/${problemId}/review`);
    const revisionThread = page
        .getByRole("article")
        .filter({ hasText: "Line three in the first version" });
    await expect(revisionThread).toContainText("revision 1");
    await revisionThread.getByRole("link", { name: "extra/b.txt:3" }).click();
    await expect(page).toHaveURL(new RegExp(`/revisions/${firstRevision}\\?path=`));
    await expect(page.locator(".cm-focus-line")).toHaveText("line three");
});

test("the new views have no horizontal scroll on a phone-sized screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, USER);
    await page.goto(`/p/${problemId}/files?path=extra/b.txt`);
    await expect(page.getByTestId("editor")).toBeVisible();
    await noHorizontalScroll(page, "the Files tab");
    await openUpload(page);
    await noHorizontalScroll(page, "the upload dialog");
    await page.keyboard.press("Escape");
    for (const [path, what] of [
        [`/p/${problemId}/revisions`, "the revisions list"],
        [`/p/${problemId}/revisions/${firstRevision}?path=extra/b.txt`, "the revision viewer"],
        [
            `/p/${problemId}/revisions/compare?from=${firstRevision}&to=working&path=extra/b.txt`,
            "the comparison",
        ],
        [`/p/${problemId}/review`, "the Review tab"],
    ]) {
        await page.goto(path!);
        await noHorizontalScroll(page, what!);
    }
});
