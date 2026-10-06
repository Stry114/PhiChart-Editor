/**
 * 可复用标签页组件：左上、左下两个工作区共用同一套实现。
 * 每个标签 = { id, label, icon?, render(el, ctx) }，切回来时会重新 render（保证状态新鲜）。
 * icon 传的是 assets/icons 下的图标名（见 src/ui/icons.js）。
 */
import { icon as makeIcon } from '../ui/icons.js';
import { capturePanelFocus, restorePanelFocus } from './detail-common.js';

export function createTabs(container, tabBody, tabs, options = {}) {
  const strip = document.createElement('div');
  strip.className = 'ed-tabs';
  container.innerHTML = '';
  container.appendChild(strip);

  const buttons = new Map();
  const badges = new Map();
  let activeId = null;

  /** 角标：传 { text, kind } 或 null（kind 由 CSS 决定颜色，如 'bad' / 'warn' / 'ok'） */
  function setBadge(id, badge) {
    if (!badge || !badge.text) badges.delete(id);
    else badges.set(id, badge);
    const btn = buttons.get(id);
    if (!btn) return null;
    btn.querySelector('.ed-tab-badge')?.remove();
    const b = badges.get(id);
    if (!b) return null;
    const span = document.createElement('span');
    span.className = `ed-tab-badge${b.kind ? ` ${b.kind}` : ''}`;
    span.textContent = String(b.text);
    if (b.title) span.title = b.title;
    btn.appendChild(span);
    return b;
  }

  function activate(id) {
    const tab = tabs.find((t) => t.id === id) ?? tabs[0];
    if (!tab) return;
    activeId = tab.id;
    for (const [tid, btn] of buttons) btn.classList.toggle('active', tid === activeId);
    // 整页重建会清掉焦点（改值 → 数据联动 refresh 走的就是这条同步路径）：先抓后还，
    // 否则焦点掉回 body，下一次 Tab 命中的是全局快速切线而不是面板里的下一个输入框
    const focusCap = capturePanelFocus(tabBody);
    tabBody.innerHTML = '';
    try {
      options.beforeRender?.(tab);
      tab.render(tabBody, options.ctx ?? {});
    } catch (err) {
      const box = document.createElement('div');
      box.className = 'ed-warn';
      box.textContent = `标签页「${tab.label}」渲染失败：${err?.message ?? err}`;
      tabBody.appendChild(box);
      console.error(err);
    }
    restorePanelFocus(tabBody, focusCap);
  }

  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.className = 'ed-tab';
    btn.type = 'button';
    if (tab.icon) {
      const ico = makeIcon(tab.icon, { size: 14 });
      ico.classList.add('ico');
      btn.appendChild(ico);
    }
    const label = document.createElement('span');
    label.textContent = tab.label;
    btn.appendChild(label);
    btn.addEventListener('click', () => activate(tab.id));
    strip.appendChild(btn);
    buttons.set(tab.id, btn);
  }

  activate(options.initial ?? tabs[0]?.id);
  return {
    get active() {
      return activeId;
    },
    activate,
    setBadge,
    getBadge(id) {
      return badges.get(id) ?? null;
    },
    /** 数据变化后刷新当前标签（例如换了谱面、拖了指针） */
    refresh() {
      if (activeId) activate(activeId);
    },
  };
}
