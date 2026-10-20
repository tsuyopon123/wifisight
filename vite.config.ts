import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** `--mode probe`: the UI as one self-contained HTML file, which wifisight-cli embeds and serves at /ui. */
const singleFile: Plugin = {
  name: "single-file",
  enforce: "post",
  generateBundle(_, bundle) {
    const html = bundle["index.html"];
    if (html?.type !== "asset") return;
    let out = String(html.source);
    const hashes: string[] = [];
    for (const [name, chunk] of Object.entries(bundle)) {
      if (name === "index.html") continue;
      const code = chunk.type === "chunk" ? chunk.code : String(chunk.source);
      // `</script` ends the element early; `<!--` + `<script` would keep it open past `</script>`.
      // Both only occur inside JS strings / regexes, where `\/` and `\x21` (= "!") read the same.
      const esc = code.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\x21--");
      const before = out;
      // function replacers: the minified code may contain `$&` etc.
      out = out
        .replace(`<script type="module" crossorigin src="/${name}"></script>`, () => {
          hashes.push(`'sha256-${createHash("sha256").update(esc).digest("base64")}'`);
          return `<script type="module">${esc}</script>`;
        })
        .replace(`<link rel="stylesheet" crossorigin href="/${name}">`, () => `<style>${esc}</style>`);
      if (out === before) this.error(`single-file: no tag in index.html for ${name}`);
      delete bundle[name];
    }
    // like the desktop app's CSP (tauri.conf.json): the page shows SSIDs etc. that anyone can broadcast
    const csp = `default-src 'self'; script-src ${hashes.join(" ")}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`;
    html.source = out.replace("<head>", () => `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  },
};

export default defineConfig(({ mode }) => ({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  plugins: mode === "probe" ? [singleFile] : [],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    ...(mode === "probe" && {
      outDir: "crates/wifi-cli/ui",
      emptyOutDir: true,
      cssCodeSplit: false,
      modulePreload: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { output: { inlineDynamicImports: true } },
    }),
  },
}));
