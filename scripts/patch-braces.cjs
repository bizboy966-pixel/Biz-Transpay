#!/usr/bin/env node
"use strict";

// Temporary local mitigation for GHSA-vfj7-8cjw-p6xm. Keep the original
// package version: vulnerability scanners cannot account for this source patch.
// Remove this script only after adopting an upstream release with the fix.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const originalHash =
  "e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310";
const anchor = "    /**\n     * Parentheses\n     */";
const guard = [
  "    // GHSA-vfj7-8cjw-p6xm: bound both brace and parenthesis AST depth.",
  "    // Escape sequences, quoted strings and character classes are handled above.",
  "    if ((value === CHAR_LEFT_CURLY_BRACE || value === CHAR_LEFT_PARENTHESES)",
  "        && stack.length > 64) {",
  "      throw new SyntaxError('Brace pattern nesting exceeds the security limit of 64');",
  "    }",
  "",
].join("\n");

function patchPackage(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  if (manifest.version !== "3.0.3") {
    throw new Error(`Review the braces security patch before using ${manifest.version}`);
  }
  const filename = path.join(directory, "lib", "parse.js");
  const source = fs.readFileSync(filename, "utf8");
  const unpatched = source.includes(guard) ? source.replace(guard, "") : source;
  const hash = crypto.createHash("sha256").update(unpatched).digest("hex");
  if (hash !== originalHash || !unpatched.includes(anchor)) {
    throw new Error(`Unexpected braces parser source: ${filename}`);
  }
  const patched = unpatched.replace(anchor, guard + anchor);
  if (source !== patched) {
    fs.writeFileSync(filename, patched);
    console.log(`Applied braces nesting guard: ${directory}`);
  }
}

const seen = new Set();
let packages = 0;

function visitPackage(directory) {
  const real = fs.realpathSync(directory);
  if (seen.has(real)) return;
  seen.add(real);
  const filename = path.join(directory, "package.json");
  if (fs.existsSync(filename)) {
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (manifest.name === "braces") {
      patchPackage(directory);
      packages++;
    }
  }
  visitModules(path.join(directory, "node_modules"));
}

function visitModules(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const child = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(child)) visitPackage(path.join(child, scoped));
    } else {
      visitPackage(child);
    }
  }
}

visitModules(path.resolve(__dirname, "../node_modules"));
visitModules(path.resolve(__dirname, "../frontend/node_modules"));
if (!packages) {
  throw new Error("No braces installation found; review dependency installation before continuing");
}
console.log(`Verified braces nesting guard in ${packages} installed package(s)`);
