/**
 * 真浏览器检查脚本（由 tools/browser-check.mjs 注入到 edit.html 的副本里运行）。
 *
 * 检查「只有浏览器里才算数」的两件事：
 *   A) Event 详情页「缓动类型」下拉能不能改（几何 / 命中测试 / 改完的值是否落到模型、时间轴、面板）
 *   B) 工作区被拉伸 / 不随布局宽度变化（面板宽度变化后曲线页与详情页是否自适应、有没有溢出）
 *
 * 结果以 STCHK|PASS/FAIL 打到 console，由 browser-check.mjs 收集。
 */

const log = [];
const check = (name, ok, extra = '') => log.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`);
/** 需要示例谱面包的检查：仓库里没有这些第三方资源，缺了就跳过（不算失败） */
const skip = (name, extra = '') => log.push(`SKIP | ${name}${extra ? ` | ${extra}` : ''}`);
const esc = (t) => String(t).replace(/\s+/g, ' ').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 详情面板里的某一行（左上工作区） */
const panelRow = (label) =>
  [...document.querySelectorAll('[data-tabbody="top"] .ed-note-row')].find(
    (r) => esc(r.querySelector('.k')?.textContent) === label,
  );
const panelSelect = (label) => panelRow(label)?.querySelector('select');

/** 两级缓动：一级选类别（linear / preset / bezier） */
async function setEasingKind(kind) {
  const sel = panelSelect('缓动类型');
  if (!sel) return false;
  sel.value = kind;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(80);
  return true;
}

/** 两级缓动：二级选编号（仅「预设缓动」类别下存在） */
async function setEasingNumber(num) {
  const sel = panelSelect('缓动编号');
  if (!sel) return false;
  sel.value = String(num);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(80);
  return true;
}

/** 等编辑器就绪（boot.js 动态 import main.js，可能要几帧） */
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 命中测试：中心点若被遮挡就多试几个点（无头环境中心点偶发返回 body） */
function hitOf(el) {
  const r = el.getBoundingClientRect();
  const pts = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 4, r.top + r.height / 2],
    [r.left + r.width / 2, r.top + 3],
    [r.left + r.width - 4, r.top + r.height / 2],
  ];
  const hits = pts.map(([x, y]) => document.elementFromPoint(x, y));
  return { ok: hits.some((h) => h === el), center: hits[0], hits };
}

/**
 * 控件可达性：先直接测；若整个控件在滚动容器的可视区之外（窗口很矮时很正常），
 * 滚动到视野内再测 —— 真正的「点不到」（被裁掉且滚不到）仍然会失败。
 */
function reachability(el) {
  const direct = hitOf(el);
  if (direct.ok) return { ok: true, how: '直接可点', hit: direct.center };
  el.scrollIntoView?.({ block: 'center' });
  const after = hitOf(el);
  return { ok: after.ok, how: after.ok ? '滚动后可达' : '滚不到', hit: after.center };
}

const api = await waitFor(() => globalThis.PhiChartEditor);
check('编辑器暴露 PhiChartEditor 全局 API', !!api);
if (!api) {
  console.log(`STCHK|FATAL|编辑器没启动`);
} else {
  // 用真实载入接口载入测试项目，然后复刻 main.js 的 afterLoad 联动（真轨道 / 真拍轴 / 真面板）
  const { makeProject } = await import('../src/ui/project.js');
  const { defaultTracks } = await import('../src/editor/tracks.js');
  const json = makeProject({ name: '自检项目', seconds: 40, lines: 2, withDemoNotes: true });
  await api.preview.loadJson(json, '自检项目');
  const chart = await waitFor(() => api.preview.chart, 10000);
  check('载入测试项目', !!chart, chart ? `${chart.lines.length} 线 / ${chart.notes.length} 音符` : '未载入');

  if (chart) {
    const { axis, tracks: defaultList } = defaultTracks(chart);
    api.timeline.setChart(chart, axis);
    api.timeline.setTracks(defaultList);
    api.timeline.resetView();
    api.refreshAll?.();
    await new Promise((r) => setTimeout(r, 80));
    const tracks = api.timeline.tracks;
    check('时间轴自动建轨（afterLoad）', tracks.length > 0, tracks.map((t) => t.key).join(','));

    const xTrack = tracks.find((t) => t.key === 'x');
    check('存在 X 位移事件轨', !!xTrack, xTrack?.id ?? '无');

    // ── A) Event 详情：缓动类型 ──
    api.timeline.selectEvents([`${xTrack.id}#0`]);
    await new Promise((r) => setTimeout(r, 60));
    check('选中事件后切到 Event 详情页', api.topTabs.active === 'event', `当前=${api.topTabs.active}`);

    const body = document.querySelector('[data-tabbody="top"]');
    const rowOf = (label) =>
      [...body.querySelectorAll('.ed-note-row')].find((r) => esc(r.querySelector('.k')?.textContent) === label);
    check('详情页有「缓动类型」行', !!rowOf('缓动类型'));
    // UI 简化：这些说明文字已删除
    const panelText = (body ?? document.querySelector('[data-tabbody="top"]')).textContent ?? '';
    check(
      '说明文字已删（事件类型提示 / 底部说明段 / 模型复读）',
      !/改类型需换轨道/.test(panelText) && !/多选时不显示默认值/.test(panelText) && !/模型复读/.test(panelText),
      (/改类型需换轨道/.test(panelText) ? '仍有事件类型提示 ' : '') +
        (/多选时不显示默认值/.test(panelText) ? '仍有底部说明 ' : '') +
        (/模型复读/.test(panelText) ? '仍有模型复读 ' : '') || '（已清空）',
    );

    const sel = rowOf('缓动类型')?.querySelector('select');
    const ev = xTrack.clips[0].ev;
    if (sel && ev) {
      const r = sel.getBoundingClientRect();
      const reach = reachability(sel);
      check('下拉尺寸非零', r.width > 60 && r.height > 12, `${Math.round(r.width)}×${Math.round(r.height)}`);
      check(
        '下拉可以点到（必要时先滚进视野）',
        reach.ok,
        `${reach.how}：${reach.hit?.tagName}.${String(reach.hit?.className ?? '').split(' ')[0]}`,
      );
      // 顺带记录一个普通数字输入框的命中结果，用来判断“中心点返回 body”是不是无头环境的通病
      const numInput = rowOf('起始值')?.querySelector('input');
      const numHit = numInput ? hitOf(numInput) : null;
      check(
        '（对照）数字输入框命中情况',
        !!numHit,
        numHit ? `center=${numHit.center?.tagName} ok=${numHit.ok}` : '无',
      );

      const before = sel.value; // 一级下拉的当前值（linear）
      check(
        '缓动一级下拉是「线性 / 预设缓动 / 贝塞尔」',
        [...sel.options].map((o) => o.textContent).join('/') === '线性/预设缓动/贝塞尔',
        [...sel.options].map((o) => o.textContent).join('/'),
      );
      await setEasingKind('preset');
      check('选「预设缓动」后出现二级「缓动编号」', !!panelSelect('缓动编号'), panelSelect('缓动编号')?.value ?? '缺失');
      await setEasingNumber(5);
      check('改缓动 → 写入源事件', ev.easingPreset === 5, `preset=${ev.easingPreset} type=${ev.easingType}`);
      check('改缓动 → 时间轴文案更新', /缓动#5/.test(xTrack.clips[0].text), xTrack.clips[0].text);
      const sel2 = panelSelect('缓动类型');
      const num2 = panelSelect('缓动编号');
      check(
        '改缓动 → 面板显示 预设缓动 + 编号 5',
        sel2?.value === 'preset' && num2?.value === '5',
        `${before} → ${sel2?.value}/${num2?.value}`,
      );
      // UI 简化：改成功时不显示任何结果行（只有真出问题才显示）
      check(
        '改成功后面板不显示多余提示行',
        !document.querySelector('[data-tabbody="top"] .ed-action'),
        esc(document.querySelector('[data-tabbody="top"] .ed-action')?.textContent ?? '（无）').slice(0, 60),
      );
      await setEasingNumber(23);
      const sel3 = panelSelect('缓动编号');
      check('再改成缓动#23 → 也生效', sel3?.value === '23' && ev.easingPreset === 23, `value=${sel3?.value} preset=${ev.easingPreset}`);
    } else {
      check('找到缓动下拉与源事件', false, `sel=${!!sel} ev=${!!ev}`);
    }

    // ── A0) 复刻用户那一层：rotate 轨 0 号（哨兵「从开头起效」事件）──
    {
      const rot = tracks.find((t) => t.key === 'rotate');
      if (!rot) {
        check('存在旋转事件轨', false, tracks.map((t) => t.key).join(','));
      } else {
        api.timeline.selectEvents([`${rot.id}#0`]);
        await new Promise((r) => setTimeout(r, 60));
        const rev = rot.clips[0].ev;
        check(
          'rotate 轨 0 号是哨兵事件（面板会显示「从开头起效」）',
          /哨兵/.test(rowOf('起始时间（拍）')?.textContent ?? ''),
          `startBeat=${rev.startBeat} endBeat=${rev.endBeat} 起=${rev.start} 止=${rev.end}`,
        );
        check(
          '改前：rotate 事件没有缓动字段',
          !Number.isFinite(rev.easingType) && !Number.isFinite(rev.easingPreset),
          `type=${rev.easingType} preset=${rev.easingPreset}`,
        );
        const rsel = panelSelect('缓动类型');
        check('改前：一级下拉显示「线性」', rsel?.value === 'linear', `value=${rsel?.value}`);
        await setEasingKind('preset');
        await setEasingNumber(9);
        check(
          'rotate 事件：改缓动后对象字段正确（type/preset 都是 9）',
          rev.easingType === 9 && rev.easingPreset === 9,
          `type=${rev.easingType} preset=${rev.easingPreset} fn.preset=${rev.easingFn?.easingPreset}`,
        );
        const rsel2 = panelSelect('缓动编号');
        check(
          'rotate 事件：面板显示 预设缓动 + 编号 9',
          panelSelect('缓动类型')?.value === 'preset' && rsel2?.value === '9',
          `${panelSelect('缓动类型')?.value}/${rsel2?.value}`,
        );
        check(
          'rotate 事件：改成功后同样没有提示行',
          !document.querySelector('[data-tabbody="top"] .ed-action'),
          esc(document.querySelector('[data-tabbody="top"] .ed-action')?.textContent ?? '（无）').slice(0, 60),
        );
        check(
          'rotate 事件：时间轴文案显示缓动#9',
          /缓动#9/.test(rot.clips[0].text),
          rot.clips[0].text,
        );
      }
    }

    // ── A1) 贝塞尔：必须出现 P1/P2 手柄 ──
    {
      const rot = tracks.find((t) => t.key === 'rotate');
      if (rot) {
        await setEasingKind('bezier');
        const rev = rot.clips[0].ev;
        check(
          '切贝塞尔：写入 4 个默认控制点',
          Array.isArray(rev.bezierPoints) && rev.bezierPoints.length === 4,
          JSON.stringify(rev.bezierPoints),
        );
        check('切贝塞尔：出现 P1/P2 输入行', !!rowOf('贝塞尔 P1.x') && !!rowOf('贝塞尔 P2.y'));
        api.topTabs.activate('curve');
        await new Promise((r) => setTimeout(r, 60));
        const svgC = document.querySelector('svg.ed-curve-svg');
        const dots = [...(svgC?.querySelectorAll('circle.ed-curve-handle') ?? [])];
        check('切贝塞尔：曲线页出现 4 个手柄（含 P1/P2）', dots.length >= 4, `${dots.length} 个手柄`);
        // 这个 rotate 哨兵事件起止值都是 0 → 取值轴退化 → 按设计退回单位方格子图
        check(
          '起止值相同的事件：退回单位方格子图（4 个手柄）',
          !!svgC?.querySelector('.ed-curve-inset') &&
            dots.filter((d) => d.classList.contains('bezier')).length === 2,
          `子图=${svgC?.querySelector('.ed-curve-inset') ? '有' : '无'} 贝塞尔手柄=${dots.filter((d) => d.classList.contains('bezier')).length}`,
        );
        // 拖动 P1：真的应该改到 bezierPoints
        const p1dot = dots.find((d) => d.classList.contains('bezier'));
        if (svgC && p1dot) {
          const box = svgC.getBoundingClientRect();
          const cx = Number(p1dot.getAttribute('cx'));
          const cy = Number(p1dot.getAttribute('cy'));
          const at = (vx, vy) => ({
            clientX: box.left + (vx / 360) * box.width,
            clientY: box.top + (vy / 240) * box.height,
          });
          const before = [...rev.bezierPoints];
          const from = at(cx, cy);
          const to = at(cx - 30, cy - 24);
          const fire = (type, pos) =>
            svgC.dispatchEvent(
              new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'mouse', ...pos }),
            );
          fire('pointerdown', from);
          fire('pointermove', to);
          fire('pointerup', to);
          await new Promise((r) => setTimeout(r, 60));
          const after = rev.bezierPoints ?? [];
          check(
            '拖动 P1 手柄会改到 bezierPoints',
            after.length === 4 && (after[0] !== before[0] || after[1] !== before[1]),
            `${JSON.stringify(before)} → ${JSON.stringify(after.map((v) => Math.round(v * 1000) / 1000))}`,
          );
          check(
            '拖动后进度值被夹在 0..1',
            after.every((v) => v >= 0 && v <= 1),
            JSON.stringify(after.map((v) => Math.round(v * 1000) / 1000)),
          );
        }
        api.topTabs.activate('event');
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    // ── A2) 边界：多选混值 / 速度事件 / 哨兵起点 ──
    {
      const yTrack = tracks.find((t) => t.key === 'y') ?? xTrack;
      // 多选：X 轨 0 号已改成 23，Y 轨保持线性 → 「缓动类型」应显示「多个值」且留空
      api.timeline.selectEvents([`${xTrack.id}#0`, `${yTrack.id}#0`]);
      await new Promise((r) => setTimeout(r, 60));
      const selMix = panelSelect('缓动类型');
      check(
        '多选混值时缓动下拉留空并提示「多个值」',
        !!selMix && selMix.value === '' && /多个值/.test(selMix.textContent ?? ''),
        `value=${selMix?.value} text=${esc(selMix?.options?.[0]?.textContent)}`,
      );
      await setEasingKind('preset');
      await setEasingNumber(8);
      const selMix2 = panelSelect('缓动编号');
      check(
        '混值状态下改缓动 → 两项都生效',
        selMix2?.value === '8' && xTrack.clips[0].ev.easingPreset === 8 && yTrack.clips[0].ev.easingPreset === 8,
        `面板=${selMix2?.value} x=${xTrack.clips[0].ev.easingPreset} y=${yTrack.clips[0].ev.easingPreset}`,
      );

      // 速度事件：可能没有缓动，但下拉仍应能改且不报错
      const speedTrack = tracks.find((t) => t.key === 'speed');
      if (speedTrack) {
        api.timeline.selectEvents([`${speedTrack.id}#0`]);
        await new Promise((r) => setTimeout(r, 60));
        const selSpd = panelSelect('缓动类型');
        if (selSpd) {
          await setEasingKind('preset');
          await setEasingNumber(4);
          const selSpd2 = panelSelect('缓动编号');
          check('速度事件的缓动也能改', selSpd2?.value === '4', `value=${selSpd2?.value}`);
        } else {
          check('速度事件面板渲染', false, esc(body.textContent).slice(0, 120));
        }
      }

      // 哨兵起点（官方「从开头起效」）：面板要标明，曲线横轴要显示为相对拍
      const sentinel = xTrack.clips[0].ev;
      sentinel.startBeat = -31249.969;
      sentinel.endBeat = 4;
      api.timeline.selectEvents([`${xTrack.id}#0`]);
      await new Promise((r) => setTimeout(r, 60));
      const startRow = rowOf('起始时间（拍）');
      check(
        '哨兵起点在面板有提示',
        /哨兵/.test(startRow?.textContent ?? ''),
        esc(startRow?.textContent).slice(0, 60),
      );
      api.topTabs.activate('curve');
      await new Promise((r) => setTimeout(r, 60));
      const xlabs = [...document.querySelectorAll('svg.ed-curve-svg .ed-curve-labels text.xlab')].map((t) => t.textContent);
      check(
        '跨度巨大的事件：横轴用相对拍（不再出现 -31249 之类）',
        xlabs.length >= 5 && !xlabs.some((t) => Number(t) < -100),
        xlabs.join(','),
      );
      const legend = document.querySelector('.ed-curve-legend');
      check('图例说明只显示末端窗口', /仅显示末端/.test(legend?.textContent ?? ''), esc(legend?.textContent).slice(0, 90));
      api.topTabs.activate('event');
      await new Promise((r) => setTimeout(r, 30));
    }

    // ── A3) 真实大谱面（官方格式，13 万事件）：改缓动是否生效 ──
    {
      const pkgPath =
        'packages/%E7%99%BD%E5%A4%8D%E7%94%9F%20AT%EF%BC%88official%E6%A0%BC%E5%BC%8F%EF%BC%89/Chart_AT%20%233649.json';
      let big = null;
      try {
        const res = await fetch(`../${pkgPath}`);
        if (res.ok) big = await res.json();
      } catch (err) {
        check('载入官方大谱面', false, String(err?.message ?? err));
      }
      // big 为空 = 仓库里没有这个包 → 上面的 skip() 已经说明，这里不再产出 FAIL
      if (!big) {
        skip('官方大谱面相关检查', '仓库里没有 packages/ 下的第三方谱面包');
      }
      if (big) {
        await api.preview.loadJson(big, '白复生 AT');
        const ok = await waitFor(() => (api.preview.chart?.lines?.length ?? 0) > 1, 30000);
        check('载入官方大谱面', !!ok, ok ? `${api.preview.chart.lines.length} 线 / ${api.preview.chart.notes.length} 音符` : '未载入');
        const { axis: bigAxis, tracks: bigTracks } = defaultTracks(api.preview.chart);
        api.timeline.setChart(api.preview.chart, bigAxis);
        api.timeline.setTracks(bigTracks);
        api.timeline.resetView();
        api.refreshAll?.();
        await new Promise((r) => setTimeout(r, 300));

        const bigY = api.timeline.tracks.find((t) => t.key === 'y');
        check('大谱面：Y 位移轨存在', !!bigY, bigY ? `${bigY.clips.length} 段` : '无');
        if (bigY) {
          // 选中间一段普通事件（跳过开头的哨兵事件）
          const idx = Math.min(5, bigY.clips.length - 1);
          api.timeline.selectEvents([`${bigY.id}#${idx}`]);
          await new Promise((r) => setTimeout(r, 150));
          check('大谱面：选中事件后切到 Event 详情页', api.topTabs.active === 'event', `当前=${api.topTabs.active}`);
          const rowB = (label) =>
            [...document.querySelectorAll('[data-tabbody="top"] .ed-note-row')].find(
              (r) => esc(r.querySelector('.k')?.textContent) === label,
            );
          const bigSel = panelSelect('缓动类型');
          check('大谱面：缓动下拉存在', !!bigSel, bigSel ? `value=${bigSel.value}` : '无');
          if (bigSel) {
            const evB = bigY.clips[idx].ev;
            await setEasingKind('preset');
            await setEasingNumber(9);
            check(
              '大谱面：改缓动后对象字段正确（type/preset 都是 9）',
              evB.easingType === 9 && evB.easingPreset === 9,
              `type=${evB.easingType} preset=${evB.easingPreset}`,
            );
            const bigSel2 = panelSelect('缓动编号');
            check(
              '大谱面：面板显示 预设缓动 + 编号 9',
              panelSelect('缓动类型')?.value === 'preset' && bigSel2?.value === '9',
              `${panelSelect('缓动类型')?.value}/${bigSel2?.value}`,
            );
            const selKey = [...api.timeline.selection.events][0];
            const selIdx = Number(selKey.slice(selKey.lastIndexOf('#') + 1));
            check(
              '大谱面：选中下标与编辑的事件一致（没有错位）',
              selIdx === idx && bigY.clips[selIdx].ev === evB,
              `selIdx=${selIdx} 期望=${idx}`,
            );
            check('大谱面：时间轴文案显示缓动#9', /缓动#9/.test(bigY.clips[selIdx].text), bigY.clips[selIdx].text);
            check(
              '大谱面：改成功后没有提示行',
              !document.querySelector('[data-tabbody="top"] .ed-action'),
              esc(document.querySelector('[data-tabbody="top"] .ed-action')?.textContent ?? '（无）').slice(0, 60),
            );

            // 起止值不同 → 控制点必须画在主图里（和两端手柄同图）
            const degEv = bigY.clips[selIdx].ev;
            if (Math.abs((degEv.end ?? 0) - (degEv.start ?? 0)) > 1e-9) {
              await setEasingKind('bezier');
              api.topTabs.activate('curve');
              await new Promise((r) => setTimeout(r, 120));
              const svgM = document.querySelector('svg.ed-curve-svg');
              const insetM = svgM?.querySelector('.ed-curve-inset');
              const dotsM = [...(svgM?.querySelectorAll('circle.ed-curve-handle') ?? [])];
              check(
                '起止值不同的事件：贝塞尔控制点画在主图里（无子图、4 个手柄）',
                !insetM && dotsM.length >= 4 && dotsM.filter((d) => d.classList.contains('bezier')).length === 2,
                `子图=${insetM ? '有' : '无'} 手柄=${dotsM.length}`,
              );
              const bezDot = dotsM.find((d) => d.classList.contains('bezier'));
              if (svgM && bezDot) {
                const box = svgM.getBoundingClientRect();
                const bx = (Number(bezDot.getAttribute('cx')) / 360) * box.width + box.left;
                const by = (Number(bezDot.getAttribute('cy')) / 240) * box.height + box.top;
                check(
                  '主图里的贝塞尔控制点落在绘图区内',
                  bx >= box.left - 1 && bx <= box.right + 1 && by >= box.top - 1 && by <= box.bottom + 1,
                  `点=(${Math.round(bx)},${Math.round(by)}) 图=(${Math.round(box.left)},${Math.round(box.top)})-(${Math.round(box.right)},${Math.round(box.bottom)})`,
                );
              }
              api.topTabs.activate('event');
              await new Promise((r) => setTimeout(r, 80));
            } else {
              check('起止值不同的 Y 事件（用于主图贝塞尔检查）', false, `起=${degEv.start} 止=${degEv.end}`);
            }
          }
        }
      }
    }

    // ── A4) RPE 谱面（The Chariot）：本来就带缓动的事件，标签必须是 缓动#N ──
    {
      let rpe = null;
      try {
        const res = await fetch('../packages/The%20Chariot/77843447.json');
        if (res.ok) rpe = await res.json();
      } catch (err) {
        check('载入 RPE 谱面（The Chariot）', false, String(err?.message ?? err));
      }
      if (rpe) {
        const { makeEventTrack } = await import('../src/editor/tracks.js');
        await api.preview.loadJson(rpe, 'The Chariot');
        const okRpe = await waitFor(() => (api.preview.chart?.lines?.length ?? 0) > 1, 30000);
        check('载入 RPE 谱面（The Chariot）', !!okRpe, okRpe ? `${api.preview.chart.lines.length} 线 / ${api.preview.chart.notes.length} 音符` : '未载入');
        const rpeChart = api.preview.chart;
        const { axis: rpeAxis } = defaultTracks(rpeChart);
        // 找一条含「非线性缓动」事件的轨
        let hit = null;
        outer: for (let li = 0; li < rpeChart.lines.length; li++) {
          const layers = rpeChart.lines[li].layers ?? [];
          for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
            for (const key of ['x', 'y', 'rotate', 'alpha']) {
              const arr = layers[layerIndex][key] ?? [];
              if (!arr.some((e) => Number.isFinite(e.easingPreset) && e.easingPreset !== 1)) continue;
              const track = makeEventTrack(rpeChart, li, layerIndex, key, rpeAxis);
              const idx = track.clips.findIndex(
                (c) => Number.isFinite(c.ev?.easingPreset) && c.ev.easingPreset !== 1 && c.ev.easingPreset !== 6,
              );
              if (idx >= 0) {
                hit = { track, idx, preset: track.clips[idx].ev.easingPreset };
                break outer;
              }
            }
          }
        }
        check('RPE 谱面里找到带缓动的事件', !!hit, hit ? `preset=${hit.preset}` : '没找到（谱面可能没有缓动）');
        if (hit) {
          api.timeline.setChart(rpeChart, rpeAxis);
          api.timeline.setTracks([hit.track]);
          api.timeline.resetView();
          api.refreshAll?.();
          await new Promise((r) => setTimeout(r, 150));
          api.timeline.selectEvents([`${hit.track.id}#${hit.idx}`]);
          await new Promise((r) => setTimeout(r, 120));
          const rowC = (label) =>
            [...document.querySelectorAll('[data-tabbody="top"] .ed-note-row')].find(
              (r) => esc(r.querySelector('.k')?.textContent) === label,
            );
          const selC = panelSelect('缓动类型');
          const selCNum = panelSelect('缓动编号');
          check(
            'RPE 带缓动事件：面板显示 预设缓动 + 编号 N（不是线性）',
            selC?.value === 'preset' && selCNum?.value === String(hit.preset),
            `类别=${selC?.value} 编号=${selCNum?.value} 期望=${hit.preset}`,
          );
          check(
            'RPE 带缓动事件：时间轴文案显示 缓动#N（不是线性）',
            new RegExp(`缓动#${hit.preset}`).test(hit.track.clips[hit.idx].text),
            hit.track.clips[hit.idx].text,
          );
        }
      }
    }

    // ── B) 布局：宽度变化是否自适应 / 有没有被拉伸 ──
    const pane = document.getElementById('ed-left-top');
    const tabbody = document.querySelector('[data-tabbody="top"]');
    for (const w of [280, 380, 720]) {
      api.layout.set({ topLeftW: w });
      await new Promise((r) => setTimeout(r, 40));
      const pr = pane.getBoundingClientRect();
      check(`面板宽度跟随设置（${w}px）`, Math.abs(pr.width - w) < 2, `实际=${Math.round(pr.width)}`);
      const row = tabbody.querySelector('.ed-note-row');
      check(
        `详情页不横向溢出（面板 ${w}px）`,
        !tabbody.scrollWidth || tabbody.scrollWidth <= tabbody.clientWidth + 1,
        `scroll=${tabbody.scrollWidth} client=${tabbody.clientWidth}`,
      );
      const ctrl = row?.querySelector('.v > *');
      if (ctrl) {
        const cr = ctrl.getBoundingClientRect();
        check(`控件未被挤扁（面板 ${w}px）`, cr.width > 40 && cr.height > 12, `${Math.round(cr.width)}×${Math.round(cr.height)}`);
      }

      // 曲线页：等比、不溢出、标题不压图
      api.topTabs.activate('curve');
      await new Promise((r) => setTimeout(r, 40));
      const svg = document.querySelector('svg.ed-curve-svg');
      if (!svg) {
        // 没选中事件时曲线页会提示先选事件：这里重新选一次
        api.timeline.selectEvents([`${xTrack.id}#0`]);
        api.topTabs.activate('curve');
        await new Promise((r) => setTimeout(r, 40));
      }
      const svg2 = document.querySelector('svg.ed-curve-svg');
      check(`曲线页渲染 SVG（面板 ${w}px）`, !!svg2);
      if (svg2) {
        const sr = svg2.getBoundingClientRect();
        const box = document.querySelector('.ed-curve-box');
        const title = document.querySelector('.ed-curve-title');
        const tr = title?.getBoundingClientRect();
        check(
          `曲线等比缩放且非零（面板 ${w}px）`,
          sr.width > 60 && sr.height > 40 && svg2.getAttribute('preserveAspectRatio') === 'xMidYMid meet',
          `${Math.round(sr.width)}×${Math.round(sr.height)} par=${svg2.getAttribute('preserveAspectRatio')}`,
        );
        // 元素本身也要是 3:2（viewBox 比例）：这样图形完整填满容器，不留空白、也不被拉伸
        check(
          `曲线图随面板宽度等比放大（面板 ${w}px）`,
          Math.abs(sr.width / sr.height - 1.5) < 0.05,
          `比例 ${(sr.width / sr.height).toFixed(3)}（应为 1.5）`,
        );
        check(
          `曲线容器不溢出（面板 ${w}px）`,
          !box || box.scrollWidth <= box.clientWidth + 1,
          box ? `box=${box.clientWidth} content=${box.scrollWidth}` : '无容器',
        );
        check(
          `标题不压住曲线（面板 ${w}px）`,
          !tr || tr.bottom <= sr.top + 1,
          tr ? `标题底=${Math.round(tr.bottom)} 图顶=${Math.round(sr.top)}` : '无标题',
        );
      }
      api.topTabs.activate('event');
      await new Promise((r) => setTimeout(r, 30));
    }

    // 窗口级别的横向溢出（整页不该出现横向滚动）
    const rows = [...document.querySelectorAll('.ed-row')];
    check(
      '窗口级不横向溢出',
      rows.every((r) => r.scrollWidth <= r.clientWidth + 1),
      rows.map((r) => `${r.id}:${r.scrollWidth}/${r.clientWidth}`).join(' '),
    );

    // Canvas「被拉伸」检测：位图比例必须与显示比例一致，否则画面会被拉扁/拉长
    for (const id of ['ed-canvas', 'ed-tl-canvas']) {
      const c = document.getElementById(id);
      if (!c) continue;
      const cr = c.getBoundingClientRect();
      if (cr.width < 4 || cr.height < 4) {
        check(`${id} 有可见尺寸`, false, `${Math.round(cr.width)}×${Math.round(cr.height)}`);
        continue;
      }
      const domRatio = cr.width / cr.height;
      const bufRatio = c.width / Math.max(1, c.height);
      check(
        `${id} 位图与显示比例一致（未被拉伸）`,
        Math.abs(domRatio - bufRatio) / domRatio < 0.02,
        `显示 ${domRatio.toFixed(3)} / 位图 ${bufRatio.toFixed(3)}`,
      );
    }

    // 右侧（预览 / 时间轴）不能被左栏挤没
    for (const [id, min] of [
      ['ed-preview', 240],
      ['ed-timeline', 240],
    ]) {
      const el2 = document.getElementById(id);
      if (!el2) continue;
      const r2 = el2.getBoundingClientRect();
      check(`${id} 未被挤没`, r2.width >= min, `宽 ${Math.round(r2.width)}`);
    }

    api.layout.set({ topLeftW: 380 });
  }
}

for (const l of log) console.log(`STCHK|${l}`);
console.log(`STDONE|${log.filter((l) => l.startsWith('FAIL')).length} 项失败`);
document.title = log.some((l) => l.startsWith('FAIL')) ? 'EDIT INTEGRATION FAIL' : 'EDIT INTEGRATION OK';
