/**
 * 开始页：**只剩两个入口** —— 编辑器 / 播放器。
 *
 * 开始页不再负责「打开项目 / 打开包 / 新建项目」：这些功能全部下放到编辑器内部
 * （进入编辑器后由醒目的欢迎弹窗引导：打开文件夹包 / 打开 zip 包 / 创建新项目）。
 * 这样文件与目录选择都在真正要用它们的那一页完成，不必再跨页交接（IndexedDB handoff）。
 */
import { icon } from '../ui/icons.js';

// 页面里静态写的是「正在加载脚本…」：脚本跑到这里就说明加载成功（也是页面自检的锚点）
const subtitleEl = document.getElementById('st-subtitle');
if (subtitleEl) subtitleEl.textContent = 'Phigros 谱面渲染器 / 制谱器 · 选择要打开的页面';

/** 页面上 data-icon 占位符换成真图标（图标资源在 assets/icons/） */
for (const holder of document.querySelectorAll('[data-icon]')) {
  const name = holder.getAttribute('data-icon');
  const size = Number(holder.getAttribute('data-icon-size')) || 18;
  holder.appendChild(icon(name, { size }));
}

// 两个入口都是普通链接：编辑器 / 播放器各自负责载入内容（不需要跨页传数据）
void document.getElementById('st-editor');
void document.getElementById('st-player');
