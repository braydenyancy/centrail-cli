// Run from the repository root: node scripts/check-doc-links.mjs
// Checks local Markdown/HTML link destinations and Markdown heading anchors.
// External URLs, code examples, and application routes are outside this check.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';

const root = process.cwd();
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter((file) => /\.md$/i.test(file));
const uniqueFiles = [...new Set(files)];
function prose(text) {
  let fence;
  return text.split('\n').map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match && !fence) { fence = match[1]; return ''; }
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      return '';
    }
    return line;
  }).join('\n');
}
const cache = new Map();
function anchors(file) {
  if (cache.has(file)) return cache.get(file);
  const text = prose(readFileSync(file, 'utf8'));
  const ids = new Set();
  const counts = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const atx = lines[i].match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    const heading = atx?.[1] ?? (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) ? lines[i] : null);
    if (heading) {
      // Remove nested tag fragments to a fixed point before forming a plain-text ID.
      let label = heading.toLowerCase();
      let previous;
      do {
        previous = label;
        label = label.replace(/<[^>]+>/g, '');
      } while (label !== previous);
      const slug = label.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
      let n = counts.get(slug) ?? 0;
      let candidate = n ? `${slug}-${n}` : slug;
      while (ids.has(candidate)) candidate = `${slug}-${++n}`;
      counts.set(slug, n + 1);
      ids.add(candidate);
    }
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  cache.set(file, ids);
  return ids;
}
let checked = 0;
const failures = [];
for (const file of uniqueFiles) {
  const text = prose(readFileSync(resolve(root, file), 'utf8'))
    .replace(/(`+)([\s\S]*?)\1/g, (span) => span.replace(/[^\n]/g, ' '));
  const links = [...text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|(?:[^\s()]|\((?:[^()]|\([^()]*\))*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g),
    ...text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm),
    ...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)];
  for (const match of links) {
    const url = match[1].replace(/^<|>$/g, '');
    if (!url || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(url)) continue;
    const [rawPath, rawAnchor] = url.split('#', 2);
    let target;
    let anchor;
    try {
      target = rawPath ? resolve(root, dirname(file), decodeURIComponent(rawPath.split('?')[0])) : resolve(root, file);
      anchor = rawAnchor ? decodeURIComponent(rawAnchor) : '';
    } catch { failures.push(`${file}: malformed URL ${url}`); continue; }
    checked++;
    const line = text.slice(0, match.index).split('\n').length;
    if (!existsSync(target)) { failures.push(`${file}:${line}: missing ${url}`); continue; }
    if (statSync(target).isDirectory()) {
      const readme = join(target, 'README.md');
      if (!existsSync(readme)) continue;
      target = readme;
    }
    if (anchor && extname(target).toLowerCase() === '.md' && !anchors(target).has(anchor)) {
      failures.push(`${file}:${line}: missing anchor ${url}`);
    }
  }
}
for (const failure of failures) console.error(failure);
console.log(`${uniqueFiles.length} Markdown files; ${checked} local links; ${failures.length} failures.`);
process.exitCode = failures.length ? 1 : 0;
