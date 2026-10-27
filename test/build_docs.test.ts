import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The GitHub Pages build (scripts/build-docs.mjs) renders the repository Markdown with marked,
// which does not emit heading ids. The Markdown already links between its own headings with
// GitHub's slugs, so every `href="#..."` on a generated page must have a matching `id`.
// README also links to `LICENSE` relative to itself; the copied page lives at /docs/readme/,
// so the build has to put the file where that link resolves.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "build-docs.mjs");

function buildInto(): { out: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "bot-social-docs-"));
  const out = join(tmp, "site"); // the build script creates it; absent means the build ignored DOCS_OUT_DIR
  execFileSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, DOCS_OUT_DIR: out },
    encoding: "utf8",
    stdio: "pipe",
  });
  return { out, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith(".html") ? [full] : [];
  });
}

const ids = (html: string) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const inPageHrefs = (html: string) => [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);

test("docs build: heading ids satisfy every in-page anchor and LICENSE resolves", () => {
  const { out, cleanup } = buildInto();
  try {
    const pages = htmlFiles(out);
    assert.ok(pages.length >= 5, `expected the landing page, docs index and four docs pages, got ${pages.length}`);

    const readme = readFileSync(join(out, "docs", "readme", "index.html"), "utf8");
    const faceRooms = readFileSync(join(out, "docs", "face-rooms", "index.html"), "utf8");

    // 1. Every Markdown-rendered heading carries an id (the page chrome aside is not Markdown).
    for (const slug of ["setup", "face-rooms", "agent-guide", "readme"]) {
      const html = readFileSync(join(out, "docs", slug, "index.html"), "utf8");
      const main = html.match(/<main class="docs-main">([\s\S]*?)<\/main>/)?.[1];
      assert.ok(main, `docs/${slug}/index.html: no <main class="docs-main"> body to inspect`);
      for (const [, depth, attrs] of main.matchAll(/<h([1-6])([^>]*)>/g)) {
        assert.match(attrs, /\bid="[^"]+"/, `docs/${slug}/index.html: <h${depth}> heading without an id`);
      }
    }

    // 2. Every `href="#x"` has an `id="x"` on the same page.
    let refs = 0;
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      const present = ids(html);
      const hrefs = inPageHrefs(html);
      refs += hrefs.length;
      for (const href of hrefs) {
        assert.ok(present.has(href), `${file}: href="#${href}" has no matching id="${href}"`);
      }
    }
    assert.ok(refs > 0, "no in-page anchors were generated; the docs links were lost");

    // 3. The slugs the Markdown links spell, on the pages that link them (GitHub's spelling).
    const expected: Array<[string, string, string[]]> = [
      [
        "docs/readme/index.html",
        "README",
        [
          "self-hosting",
          "presence-thinking-signal",
          "typed-by-owner-attested-human-lines",
          "reply-only-join-grants-unshared-bots",
          "security-humans-decide",
        ],
      ],
      [
        "docs/face-rooms/index.html",
        "FACE_ROOMS",
        [
          "bot-look-avatar-and-color",
          "room-lead-flybot-476",
          "post-v1face-roomsjoin",
          "put-v1face-roomsidroles",
        ],
      ],
    ];
    for (const [rel, label, slugs] of expected) {
      const html = readFileSync(join(out, rel), "utf8");
      for (const slug of slugs) {
        assert.ok(html.includes(`id="${slug}"`), `${label}: missing id="${slug}"`);
      }
    }
    assert.ok(readme.includes('id="self-hosting"'), "README: the Self-hosting heading has no id");
    assert.ok(faceRooms.length > 0);

    // 4. Every relative LICENSE link in the built README resolves to a file in the output.
    const pageUrl = pathToFileURL(join(out, "docs", "readme", "index.html"));
    const hrefs = [...readme.matchAll(/href="(\.?\/?LICENSE)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 2, `README: expected the MIT badge and [MIT](LICENSE) link, found ${hrefs.length}`);
    for (const href of hrefs) {
      const target = fileURLToPath(new URL(href, pageUrl));
      assert.ok(
        resolve(target).startsWith(resolve(out) + sep),
        `README: ${href} escapes the output directory (${target})`,
      );
      assert.ok(existsSync(target), `README: href="${href}" resolves to ${target}, which does not exist`);
      assert.ok(statSync(target).isFile(), `README: href="${href}" resolves to a non-file`);
    }
  } finally {
    cleanup();
  }
});
