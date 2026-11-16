import { zip } from "fflate";

/** Builds a zip off the event loop, so a large archive does not stall every other request. */
export const zipFiles = (files: Record<string, Uint8Array>): Promise<Buffer> =>
    new Promise((resolve, reject) => zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(Buffer.from(data)))));
