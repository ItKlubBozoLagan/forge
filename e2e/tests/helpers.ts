import { expect, Page } from "@playwright/test";

/** Signs in through the development login form. */
export const signIn = async (page: Page, name: string) => {
    await page.goto("/login");
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "New problem" }).first()).toBeVisible();
};

export const createProblem = async (page: Page, title: string, template = "ioi") => {
    await page.getByRole("button", { name: "New problem" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Template").selectOption(template);
    await dialog.getByRole("button", { name: /create/i }).click();
    await expect(page).toHaveURL(/\/p\/\d+\//);
    return page.url().match(/\/p\/(\d+)\//)![1]!;
};

/** Reads a file of the working copy through the API with the page's session. */
export const readFile = async (page: Page, problemId: string, path: string) => {
    const response = await page.request.get(`/api/problems/${problemId}/file?path=${encodeURIComponent(path)}`);
    expect(response.ok()).toBe(true);
    return response.text();
};

/** Replaces the content of the open editor and saves it. */
export const replaceEditorContent = async (page: Page, content: string) => {
    const editor = page.getByTestId("editor").locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(content);
    await page.getByRole("button", { name: "Save", exact: true }).click();
};

export const openFile = async (page: Page, problemId: string, path: string) => {
    await page.goto(`/p/${problemId}/files`);
    await page.getByTestId(`file-${path}`).click();
    await expect(page.getByTestId("editor").locator(".cm-content")).toBeVisible();
};

/** Starts a build of the working copy and waits for its result. */
export const build = async (page: Page, expected: "green" | "red") => {
    await page.getByRole("button", { name: "Build", exact: true }).click();
    await expect(page).toHaveURL(/\/builds\/\d+/);
    await expect(page.getByTestId("build-status")).toHaveText(new RegExp(expected, "i"), { timeout: 200_000 });
};
