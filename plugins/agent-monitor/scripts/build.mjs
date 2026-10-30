import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const common = { absWorkingDir: root, bundle: true, write: false, legalComments: 'inline', logLevel: 'warning' };
const [server, ui] = await Promise.all([
  build({ ...common, entryPoints: ['src/main.mjs'], platform: 'node', target: 'node24', format: 'esm',
    outfile: 'dist/server.mjs', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } }),
  build({ ...common, entryPoints: ['ui/app.mjs'], platform: 'browser', target: 'es2022', format: 'esm', minify: true, outfile: 'dist/app.js' })
]);
const [template, css] = await Promise.all([
  readFile(join(root, 'ui/index.html'), 'utf8'), readFile(join(root, 'ui/styles.css'), 'utf8')
]);
const html = template
  .replace(/<link\b[^>]*href=["']\.\/styles\.css["'][^>]*>/, () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
  .replace(/<script\b[^>]*src=["']\.\/app\.mjs["'][^>]*>\s*<\/script>/, () => `<script type="module">${ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
if (html === template || /(?:src|href)=["']\.\/(?:app\.mjs|styles\.css)/.test(html)) throw new Error('UI template must contain the stylesheet and module entrypoints.');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const notices = ['Agent Monitor bundled third-party notices.\n'];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue;
  const folder = join(root, path);
  const names = (await readdir(folder)).filter((name) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(name)).sort();
  notices.push(`\n===== ${path.replace(/^node_modules\//, '')}@${entry.version} (${entry.license || 'see package license'}) =====\n`);
  for (const name of names) notices.push(await readFile(join(folder, name), 'utf8'));
}
const outputs = [...server.outputFiles.map((f) => [f.path, f.contents]),
  [join(root, 'dist/dashboard.html'), Buffer.from(html)],
  [join(root, 'dist/THIRD_PARTY_NOTICES.txt'), Buffer.from(notices.join('\n'))]];
for (const [path, bytes] of outputs) {
  const contents = Buffer.from(Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n'));
  if (check) {
    const current = await readFile(path).catch(() => null);
    if (!current || !Buffer.from(contents).equals(current)) throw new Error(`Generated artifact is stale: ${relative(root, path)}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}
console.log(check ? 'Bundled artifacts match source.' : 'Built self-contained MCP server and dashboard.');
