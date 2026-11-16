import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.FORGE_API_URL ?? "http://127.0.0.1:8090";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 3200,
        strictPort: true,
        proxy: { "/api": { target: apiTarget, changeOrigin: false } },
    },
    preview: {
        port: 3200,
        strictPort: true,
        proxy: { "/api": { target: apiTarget, changeOrigin: false } },
    },
    build: {
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            output: {
                manualChunks: (id) => {
                    if (!id.includes("node_modules")) return undefined;
                    if (/@codemirror|@lezer|@uiw|codemirror/.test(id)) return "codemirror";
                    if (/katex|micromark|mdast|hast|unified|remark|rehype|react-markdown/.test(id))
                        return "markdown";
                    if (/zod|yaml/.test(id)) return "manifest";
                    return "vendor";
                },
            },
        },
    },
});
