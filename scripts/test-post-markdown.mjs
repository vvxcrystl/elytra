import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the actual TSX component without starting a database or Next server.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      specifier = new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href;
    }
    if (specifier === "./social-text") specifier = "./social-text.ts";
    if (specifier === "next/link") specifier = "next/link.js";
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && /\.(ts|tsx)$/.test(url) && !url.includes("/node_modules/")) {
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return next(url, context);
  },
});
const { PostContent } = await import("../src/components/post-content.tsx");
const render = (text, props = {}) => renderToStaticMarkup(createElement(PostContent, { text, ...props }));
const html = render("# Heading\n\n**bold** *italic* ~~gone~~ `code`\n\n- first\n- second\n\n> quote\n\n[site](https://example.com)\n\nline one\nline two");
for (const tag of ["h1", "strong", "em", "del", "code", "ul", "li", "blockquote", "br"]) {
  assert.match(html, new RegExp(`<${tag}[ >/]`), `renders ${tag}`);
}
assert.match(html, /rel="noopener noreferrer nofollow"/);
const social = render("**@alice #café** and https://example.com\n\n`@code #code`\n\n```\n@fence #fence\n```\n\n[label @inside](https://example.com)");
assert.match(social, /href="\/alice"/);
assert.match(social, /href="\/explore\?q=%23caf%C3%A9"/);
for (const name of ["code", "fence", "inside"]) assert(!social.includes(`href="/${name}"`));
assert.equal((social.match(/<a /g) || []).length, 4, "no links nested in Markdown links or code");
const unsafe = render('[bad](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n![image](https://example.com/tracker.png)');
assert(!unsafe.includes('href="javascript:'));
assert(!unsafe.includes("<script"));
assert(!unsafe.includes("<img"));
assert.match(unsafe, /image/);
assert(!render("@alice [site](https://example.com)", { interactive: false }).includes("<a"));
assert.match(render("| A | B |\n| - | - |\n| 1 | 2 |"), /<table>/);
assert.match(render("- [x] done"), /type="checkbox" disabled="" checked=""/);
console.log("PASS Markdown formatting, social links, line breaks, quotes, tables, tasks, and unsafe content");
