#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[sc]e|copying|unlicense|notice)([-_.].*)?$/i;

const packages = [];

function readLicenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && !f.endsWith(".rs"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").trim() }))
    .filter((t) => t.text.length > 0);
}

const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
for (const [key, meta] of Object.entries(lock.packages)) {
  if (!key || meta.dev) continue;
  const dir = join(root, key);
  const name = key.replace(/^.*node_modules\//, "");
  let license = meta.license;
  if (!license && existsSync(join(dir, "package.json"))) {
    license = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).license;
  }
  let holders = [];
  if (existsSync(join(dir, "package.json"))) {
    const a = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).author;
    if (a) holders = [typeof a === "string" ? a.replace(/\s*[<(].*$/, "") : a.name];
  }
  if (holders.length === 0 && name.startsWith("@fluentui/")) holders = ["Microsoft Corporation"];
  packages.push({
    name,
    version: meta.version,
    license: typeof license === "string" ? license : JSON.stringify(license ?? "UNKNOWN"),
    texts: readLicenseFiles(dir),
    holders,
  });
}

const cargoEnv = { ...process.env, PATH: `${join(homedir(), ".cargo/bin")}:${process.env.PATH}` };
const crates = new Map();
for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
  const r = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--filter-platform", target, "--offline"],
    { cwd: join(root, "src-tauri"), env: cargoEnv, encoding: "utf8", maxBuffer: 1 << 29 }
  );
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  const meta = JSON.parse(r.stdout);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps) {
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  for (const id of seen) {
    const p = byId.get(id);
    crates.set(`${p.name}@${p.version}`, p);
  }
}
for (const p of crates.values()) {
  packages.push({
    name: p.name,
    version: p.version,
    license: p.license ?? "UNKNOWN",
    texts: readLicenseFiles(dirname(p.manifest_path)),
    holders: (p.authors ?? []).map((a) => a.replace(/\s*<.*$/, "")),
  });
}

const MIT = (h) => `MIT License

Copyright (c) ${h}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const ZLIB = (h) => `zlib License

Copyright (c) ${h}

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a
   product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;
const BSD3 = (h) => `BSD 3-Clause License

Copyright (c) ${h}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

function fallbackText(p) {
  const h = p.holders.filter(Boolean).join(", ") || "the authors of " + p.name;
  if (/\bMIT\b/.test(p.license) && !/MPL/.test(p.license)) return MIT(h);
  if (/\bZlib\b/.test(p.license)) return ZLIB(h);
  if (/BSD-3-Clause/.test(p.license)) return BSD3(h);
  return null;
}

const norm = (t) => t.replace(/\s+/g, " ").trim();
const groups = new Map();
const missing = [];
for (const p of packages) {
  if (p.texts.length === 0) {
    const text = fallbackText(p);
    if (text) {
      const k = norm(text);
      if (!groups.has(k)) groups.set(k, { text, pkgs: new Set(), reconstructed: true });
      groups.get(k).pkgs.add(`${p.name} ${p.version}`);
    } else {
      missing.push(p);
    }
    continue;
  }
  for (const t of p.texts) {
    const k = norm(t.text);
    if (!groups.has(k)) groups.set(k, { text: t.text, pkgs: new Set() });
    groups.get(k).pkgs.add(`${p.name} ${p.version}`);
  }
}

const bySpdx = new Map();
for (const p of packages) {
  bySpdx.set(p.license, (bySpdx.get(p.license) ?? 0) + 1);
}
const mpl = packages.filter((p) => /MPL-2\.0/.test(p.license));

let out = `# Third-party notices

Doftar is built on the open-source packages below. Each is distributed
under its own license; the full texts follow, grouped by identical text.
Generated by \`scripts/gen-notices.mjs\`. Do not edit by hand.

## Summary

| License (SPDX) | Packages |
|---|---|
${[...bySpdx.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `| ${k} | ${n} |`)
  .join("\n")}

No package is under a strong-copyleft license (GPL, LGPL, AGPL).

## Mozilla Public License 2.0 packages

${mpl.map((p) => `- ${p.name} ${p.version}`).join("\n")}

These crates are used unmodified as dependencies. MPL-2.0 is file-level
copyleft: their source is available from https://crates.io/crates/<name> and
https://www.mozilla.org/MPL/2.0/ , and any modification to those files must
be published under MPL-2.0. This does not affect Doftar's own source.

## Trademarks

Windows, Segoe and Fluent are trademarks of Microsoft Corporation. Finder and
macOS are trademarks of Apple Inc. Doftar is an independent project and is
not affiliated with, sponsored by, or endorsed by either company.

## License texts
`;

let n = 0;
for (const { text, pkgs, reconstructed } of [...groups.values()].sort(
  (a, b) => b.pkgs.size - a.pkgs.size || a.text.localeCompare(b.text)
)) {
  n++;
  out += `\n### ${n}. Used by (${pkgs.size})${reconstructed ? " (no license file shipped by the package: standard SPDX text, copyright holders from package metadata)" : ""}\n\n${[...pkgs].sort().join(", ")}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
}

if (missing.length) {
  out += `\n## Packages without a license file in their distribution\n\nLicense identifier only (SPDX, from package metadata); full text at https://spdx.org/licenses/ :\n\n${missing
    .map((p) => `- ${p.name} ${p.version}: ${p.license}`)
    .join("\n")}\n`;
}

writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), out);
console.log(
  `${packages.length} packages, ${groups.size} distinct license texts, ${missing.length} without a license file`
);
