// 启动引导：版本守卫 + 出错时在页面上显示可读错误（不再是一片空白）
//
// 背景：编辑器脚本与 edit.html 是分开的两个文件，浏览器可能只缓存了其中一个。
// 旧 HTML + 新 JS 会缺元素，以前会导致整个模块抛错、界面只剩静态骨架。
// 这里先比对版本号，再把 main.js 的加载/初始化包在 try/catch 里，任何失败都显示出来。
export const PAGE_VERSION = '6';

function showFatal(title, detail) {
  const box = document.createElement('div');
  box.className = 'ed-fatal';
  const h = document.createElement('h2');
  h.textContent = title;
  box.appendChild(h);
  const pre = document.createElement('pre');
  pre.textContent = detail;
  box.appendChild(pre);
  const hint = document.createElement('p');
  hint.className = 'dim';
  hint.textContent = '请强制刷新页面（Ctrl+F5 / Cmd+Shift+R）。';
  box.appendChild(hint);
  const back = document.createElement('a');
  back.className = 'ed-btn';
  back.href = 'index.html';
  back.textContent = '返回开始页';
  box.appendChild(back);
  document.body.appendChild(box);
  console.error('[editor] 启动失败：', title, detail);
}

/** 启动提示层（edit.html 里静态写着，慢网络下先让用户看到"正在加载"而不是空白骨架） */
function hideLoading() {
  document.getElementById('ed-loading')?.remove();
}

const pageVersion = document.documentElement?.dataset?.editorVersion;
if (pageVersion && pageVersion !== PAGE_VERSION) {
  hideLoading();
  showFatal(
    '页面版本不匹配：请强制刷新',
    `edit.html 是 v${pageVersion}，编辑器脚本是 v${PAGE_VERSION}（浏览器可能缓存了旧页面）。`,
  );
} else {
  try {
    await import('./main.js');
    hideLoading();
  } catch (err) {
    hideLoading(); // 先撤掉提示层，错误面板才看得见
    showFatal('编辑器启动失败', `${err?.message ?? err}\n\n${err?.stack ?? ''}`);
  }
}
