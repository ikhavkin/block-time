// Builds: dist/<name>.user.js (Greasy Fork / raw-link installs), linear-block-ext/ (unpacked Chrome
// extension, path kept stable so an already-loaded extension only needs a reload), and the bookmarklet.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repo = (pkg.repository && pkg.repository.url || '').replace(/^git\+|\.git$/g, '').replace(/^https:\/\/github\.com\//, '') || 'OWNER/REPO';
const RAW = `https://raw.githubusercontent.com/${repo}/main/dist`;
const HOME = `https://github.com/${repo}`;

const common = {
  bundle: true,
  absWorkingDir: root,   // path comments ("// src/shared.ts") stay relative whatever the cwd, so the output is reproducible
  format: 'iife',
  target: ['chrome120', 'firefox120', 'safari17'],
  minify: false,
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
  write: false,
};

function header(o) {
  const lines = [
    '// ==UserScript==',
    `// @name         ${o.name}`,
    `// @namespace    ${HOME}`,
    `// @version      ${pkg.version}`,
    `// @description  ${o.description}`,
    `// @author       ${pkg.author || 'ikhavkin'}`,
    `// @license      ${pkg.license}`,
    `// @homepageURL  ${HOME}`,
    `// @supportURL   ${HOME}/issues`,
    `// @updateURL    ${RAW}/${o.file}`,
    `// @downloadURL  ${RAW}/${o.file}`,
    ...o.match.map((m) => `// @match        ${m}`),
    '// @run-at       document-idle',
    '// @noframes',
    '// @grant        GM_getValue',
    '// @grant        GM_setValue',
    '// @grant        GM_deleteValue',
    '// @grant        GM_registerMenuCommand',
    // Greasemonkey 4 silently discards the GM_* spellings, so the dotted ones are mandatory there.
    '// @grant        GM.getValue',
    '// @grant        GM.setValue',
    '// @grant        GM.deleteValue',
    '// @grant        GM.registerMenuCommand',
    '// ==/UserScript==',
    '',
  ];
  return lines.join('\n');
}

const SCRIPTS = [
  {
    entry: 'src/linear.entry.ts', file: 'linear-block-time.user.js', ext: 'content.js',
    name: 'Linear → Google Calendar block',
    description: 'On a Linear issue page, press Option+B or click "📅 Block time" next to Activity to open a prefilled Google Calendar event: "<ID> <title>", Linear URL in the description, duration from the T-shirt estimate.',
    match: ['https://linear.app/*'],
  },
  {
    entry: 'src/reclaim.entry.ts', file: 'reclaim-block-time.user.js', ext: 'reclaim.js',
    name: 'Reclaim task → Google Calendar block',
    description: 'Reclaim Planner: "📅 Block" on every task row (prefilled Google Calendar event), "↗" on calendar events that belong to a Linear / Google Tasks / Todoist task, "＋" to link or create a Linear issue for an event, plus a "⚡" energy badge on Linear-linked events. The optional Linear personal API key you enter is stored by the script manager and sent only to api.linear.app.',
    match: ['https://app.reclaim.ai/*'],
  },
];

mkdirSync(join(root, 'dist'), { recursive: true });
mkdirSync(join(root, 'linear-block-ext'), { recursive: true });

for (const s of SCRIPTS) {
  const r = await build({ ...common, entryPoints: [join(root, s.entry)] });
  const code = r.outputFiles[0].text;
  writeFileSync(join(root, 'dist', s.file), header(s) + code);
  writeFileSync(join(root, 'linear-block-ext', s.ext), code);
  console.log(`built dist/${s.file} (${code.length} bytes) + linear-block-ext/${s.ext}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'src/ext/manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(root, 'linear-block-ext/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// A bookmark URL goes through the browser's URL parser, which removes raw newlines and decodes %XX,
// so the bookmarklet must be one line: template literals are lowered to concatenation to keep "\n"
// as an escape. It must also stay free of the page script (main() with its poller and storage).
const bm = await build({ ...common, entryPoints: [join(root, 'src/bookmarklet.ts')], minify: true, supported: { 'template-literal': false } });
const bmCode = bm.outputFiles[0].text.trim();
if (/setInterval|GM_getValue|localStorage|chrome\.storage/.test(bmCode)) throw new Error('bookmarklet bundled the userscript main()');
if (/[\r\n]/.test(bmCode)) throw new Error('bookmarklet must be a single line (bookmark URLs drop newlines)');
if (/%[0-9a-fA-F]{2}/.test(bmCode)) throw new Error('bookmarklet must not contain %XX sequences (bookmark URLs decode them)');
writeFileSync(join(root, 'dist/linear-block-time.bookmarklet.js'), 'javascript:' + bmCode);
console.log(`built dist/linear-block-time.bookmarklet.js (${bmCode.length} bytes)`);
