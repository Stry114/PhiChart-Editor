// 通过可达镜像取 GitHub 原始文件（见 docs/Phigros文档.md 的参考项目与许可）
// usage: node tools/gh-raw.mjs <owner/repo@ref> <path> [outFile]
const [repo, path, outFile] = process.argv.slice(2);
const urls = [
  `https://gcore.jsdelivr.net/gh/${repo}${path}`,
  `https://jsdelivr.b-cdn.net/gh/${repo}${path}`,
];
const fs = await import('node:fs');
for (const u of urls) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) continue;
    const t = await r.text();
    if (outFile) {
      fs.writeFileSync(outFile, t, 'utf8');
      console.log(`saved ${outFile} (${t.length} chars) from ${u}`);
    } else {
      process.stdout.write(t);
    }
    process.exit(0);
  } catch (e) {
    console.error('fail', u, e.cause?.message || e.message);
  }
}
process.exit(1);
