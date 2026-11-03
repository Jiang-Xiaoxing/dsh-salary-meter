window.__ModuleLoader__.load({
  id: 'dsh-salary-meter',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef } = React;
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives');
    let core;

    function SalaryWidget() {
      const [snapshot, setSnapshot] = useState(null);
      const [now, setNow] = useState(Date.now());
      const [error, setError] = useState('');
      const [caughtUntil, setCaughtUntil] = useState(0);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const dialog = useRef(null);
      const widget = useRef(null);
      const drag = useRef(null);
      useEffect(() => {
        const abort = new AbortController();
        let timer;
        async function update() {
          try {
            const response = await fetch('/api/salary-meter/state', { signal: abort.signal });
            if (!response.ok) throw new Error('工资信息暂时无法读取');
            const value = await response.json();
            if (abort.signal.aborted) return;
            setSnapshot(value);
            setError(value.error || '');
          } catch (error) {
            if (!abort.signal.aborted) setError(error.message);
          } finally {
            if (!abort.signal.aborted) timer = setTimeout(update, 2000);
          }
        }
        import('/api/salary-meter/core.mjs').then(module => {
          if (abort.signal.aborted) return;
          core = module;
          update();
        }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
        const clock = setInterval(() => setNow(Date.now()), 100);
        return () => { abort.abort(); clearTimeout(timer); clearInterval(clock); };
      }, []);
      useEffect(() => {
        if (settingsOpen && dialog.current && !dialog.current.open) dialog.current.showModal();
      }, [settingsOpen]);

      if (!snapshot || !core) {
        return h('section', { 'data-salary-meter': true, className: 'sm-widget', role: 'status' }, error || '正在读取工资与饭钱…');
      }
      const wage = core.computeWage(snapshot.config, new Date(now));
      const expenses = snapshot.today.expense;
      const partial = snapshot.today.unknown > 0;
      const amount = wage.earned - expenses;
      const pose = now < caughtUntil ? 'caught' : (snapshot.active > 0 || now - snapshot.lastExpenseAt < 4000) ? 'eat' : 'idle';
      const clockText = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
      const money = value => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const expenseText = expenses > 0 && expenses < 0.01 ? expenses.toFixed(4) : money(expenses);
      const feeDescription = '按已识别的 DeepSeek 官方模型 token 和 2026-11-03 单价估算。节假日调整、搜索抓取、辅助调用和第三方模型费用未纳入。';
      return h('section', { ref: widget, 'data-salary-meter': true, className: 'sm-widget', 'aria-label': '打工养肥鱼' },
        h('div', { className: 'sm-top',
          onPointerDown: event => {
            if (event.target.closest('button')) return;
            const bounds = widget.current.getBoundingClientRect();
            drag.current = { x: event.clientX - bounds.x, y: event.clientY - bounds.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerMove: event => {
            if (!drag.current) return;
            const left = Math.max(0, Math.min(innerWidth - widget.current.offsetWidth, event.clientX - drag.current.x));
            const top = Math.max(0, Math.min(innerHeight - widget.current.offsetHeight, event.clientY - drag.current.y));
            Object.assign(widget.current.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
          },
          onPointerUp: () => { drag.current = null; },
          onPointerCancel: () => { drag.current = null; },
        },
          h('span', { className: 'sm-status' }, h('i', { 'data-working': wage.status === '上班中' }), wage.status),
          h('time', { className: 'sm-clock' }, clockText),
          h(Button, { size: 'sm', variant: 'ghost', title: '工资参数设置', 'aria-label': '工资参数设置', onClick: () => setSettingsOpen(true) }, '⋯')),
        h('div', { className: 'sm-balance', title: partial ? '部分调用费用待支持，余额为上限估算' : '当日工资减去已统计的模型费用估算' },
          h('small', null, partial ? '≤ ¥' : '≈ ¥'), h('span', null, money(amount)), h('label', null, '碗里还剩')),
        // A mascot button has a custom image surface rather than a standard control shape.
        h('button', { className: `sm-mascot sm-${pose}`, title: '发现她偷吃', 'aria-label': '发现鲸鱼娘偷吃', onClick: () => setCaughtUntil(Date.now() + 2500) },
          h('img', { src: '/api/salary-meter/mascot.png', alt: '' })),
        h('div', { className: 'sm-bubble' }, pose === 'caught' ? '饭自己跑嘴里的。' : pose === 'eat' ? '我就吃一小口。' : '等你赚饭钱呀。'),
        h('div', { className: 'sm-worktime' },
          h('div', { className: 'sm-worktime-row' },
            h('span', null, wage.countdownLabel, ' ', h('b', null, wage.countdownSeconds > 0 ? core.formatDuration(wage.countdownSeconds) : '')),
            h('span', null, `今日进度 ${Math.round(wage.progress * 100)}%`)),
          h('progress', { value: wage.progress, max: 1, 'aria-label': '今日工作进度' })),
        h('div', { className: 'sm-ledger' },
          h('div', null, h('label', null, '今日打工入账'), h('b', null, `¥${money(wage.earned)}`)),
          h('div', { className: 'sm-expense', title: feeDescription }, h('label', null, partial ? '偷吃估算（有遗漏）' : '今日肥鱼偷吃（估算）'), h('b', null, `${partial ? '≥' : '−'} ¥${expenseText}`))),
        error && h('p', { className: 'sm-error', role: 'alert' }, error),
        settingsOpen && h('dialog', { ref: dialog, className: 'sm-settings', onClose: () => setSettingsOpen(false) },
          h('button', { className: 'sm-close', 'aria-label': '关闭参数设置', onClick: () => dialog.current.close() }, '×'),
          h('iframe', { src: '/api/salary-meter/settings', title: '工资参数设置' })));
    }

    return {
      name: 'salary-meter', inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const stylesheet = document.createElement('link');
          stylesheet.rel = 'stylesheet';
          stylesheet.href = '/api/salary-meter/widget.css';
          document.head.append(stylesheet);
          return () => stylesheet.remove();
        }, 'salary-meter: styles');
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({ name: 'shell.overlay', id: 'salary-meter', order: 900 }, SalaryWidget);
        });
      },
    };
  },
});
