import { spawn } from "node:child_process";

const color = (code: number) => (text: string) =>
    process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const dim = color(2);
export const bold = color(1);

export const info = (message = "") => console.log(message);
export const warn = (message: string) => console.error(`warning: ${message}`);

/** Runs `fn` over `items` with bounded parallelism, keeping result order. */
export const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Best effort: failures are ignored. */
export const openBrowser = (url: string) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.on("error", () => undefined);
        child.unref();
    } catch {
        // no opener available
    }
};
