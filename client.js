window.__ModuleLoader__.load({
  id: 'dsh-salary-meter',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef } = React;
    const { createPortal } = require('react-dom');
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives');
    let core;

    function WhaleMascot({ caught, busy, onAction }) {
      const canvas = useRef(null);
      const controller = useRef(null);
      const current = useRef({ caught, busy });
      current.current = { caught, busy };
      const [failed, setFailed] = useState(false);
      useEffect(() => {
        const abort = new AbortController();
        import('/api/salary-meter/mascot.mjs').then(({ createWhaleAnimation }) => {
          if (abort.signal.aborted) return;
          return createWhaleAnimation(canvas.current, { signal: abort.signal, onAction, onError: () => setFailed(true) });
        }).then(value => {
          if (!value) return;
          if (abort.signal.aborted) { value.dispose(); return; }
          controller.current = value;
          value.setBusy(current.current.busy);
          if (current.current.caught) value.catch();
        }).catch(error => { if (!abort.signal.aborted) { console.error('[salary-meter] animation unavailable', error.message); setFailed(true); } });
        return () => { abort.abort(); controller.current?.dispose(); controller.current = null; };
      }, []);
      useEffect(() => { if (caught) controller.current?.catch(); }, [caught]);
      useEffect(() => { controller.current?.setBusy(busy); }, [busy]);
      return failed
        ? h('img', { src: '/api/salary-meter/actions.png', alt: '' })
        : h('canvas', { ref: canvas, width: 224, height: 224, 'aria-hidden': true });
    }

    function SalaryWidget() {
      const [snapshot, setSnapshot] = useState(null);
      const [now, setNow] = useState(Date.now());
      const [error, setError] = useState('');
      const [caughtUntil, setCaughtUntil] = useState(0);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [savingView, setSavingView] = useState(false);
      const [mascotAction, setMascotAction] = useState('idle');
      const dialog = useRef(null);
      const widget = useRef(null);
      const drag = useRef(null);
      const manuallyPlaced = useRef(false);
      useEffect(() => {
        const abort = new AbortController();
        let timer;
        async function update() {
          try {
            const response = await fetch('/api/salary-meter/state', { signal: abort.signal });
            if (!response.ok) throw new Error('工资信息暂时无法读取');
            const value = await response.json();
            if (abort.signal.aborted) return;
            setSnapshot(previous => {
              const next = { ...value };
              if (previous?.revision > value.revision) {
                next.config = previous.config;
                next.revision = previous.revision;
              }
              if (previous?.view.revision > value.view.revision) next.view = previous.view;
              return next;
            });
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
      useEffect(() => {
        function savedSettings(event) {
          const frame = dialog.current?.querySelector('iframe');
          if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'salary-meter:config-saved') return;
          const { config, revision } = event.data;
          setSnapshot(previous => previous.revision > revision ? previous : { ...previous, config, revision });
          dialog.current.close();
        }
        function savedTheme(event) {
          const frame = dialog.current?.querySelector('iframe');
          if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.type !== 'salary-meter:theme') return;
          const theme = ['light', 'gold'].includes(event.data.theme) ? event.data.theme : 'dark';
          fetch('/api/salary-meter/view', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) })
            .then(response => response.json())
            .then(value => setSnapshot(previous => previous ? { ...previous, view: value } : previous))
            .catch(() => {});
        }
        window.addEventListener('message', savedSettings);
        window.addEventListener('message', savedTheme);
        return () => { window.removeEventListener('message', savedSettings); window.removeEventListener('message', savedTheme); };
      }, []);
      useEffect(() => {
        if (!snapshot) return;
        let scheduled;
        function place() {
          if (!widget.current) return;
          const box = widget.current.getBoundingClientRect();
          if (manuallyPlaced.current) {
            Object.assign(widget.current.style, {
              left: `${Math.max(12, Math.min(innerWidth - box.width - 12, box.left))}px`,
              top: `${Math.max(12, Math.min(innerHeight - box.height - 12, box.top))}px`,
            });
            return;
          }
          const send = [...document.querySelectorAll('button')].find(button => ['发送消息', 'Send message', 'Send'].includes(button.getAttribute('aria-label')));
          const control = send?.getBoundingClientRect();
          const left = Math.max(12, innerWidth - box.width - 20);
          const candidates = [innerHeight - box.height - 100, innerHeight - box.height - 20, 64];
          const top = candidates.find(value => {
            if (value < 12 || value + box.height > innerHeight - 12) return false;
            return !control || left >= control.right || left + box.width <= control.left || value >= control.bottom || value + box.height <= control.top;
          }) ?? 12;
          Object.assign(widget.current.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
        }
        function schedule(event) {
          if (event?.target instanceof Element && event.target.closest('[data-salary-meter]')) return;
          clearTimeout(scheduled);
          scheduled = setTimeout(place, 100);
        }
        place();
        window.addEventListener('resize', schedule);
        document.addEventListener('click', schedule);
        document.addEventListener('input', schedule);
        return () => {
          clearTimeout(scheduled);
          window.removeEventListener('resize', schedule);
          document.removeEventListener('click', schedule);
          document.removeEventListener('input', schedule);
        };
      }, [Boolean(snapshot), snapshot?.active, snapshot?.view.expanded]);

      async function toggleView() {
        setSavingView(true);
        try {
          const response = await fetch('/api/salary-meter/view', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expanded: !snapshot.view.expanded }),
          });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || '显示设置保存失败');
          setSnapshot(previous => ({ ...previous, view: value }));
        } catch (error) {
          setError(error.message);
        } finally {
          setSavingView(false);
        }
      }

      if (!snapshot || !core) {
        return createPortal(h('section', { 'data-salary-meter': true, className: 'sm-widget', role: 'status' }, error || '正在读取工资与饭钱…'), document.body);
      }
      const wage = core.computeWage(snapshot.config, new Date(now));
      const expenses = snapshot.today.expense;
      const partial = snapshot.today.unknown > 0;
      const amount = wage.earned - expenses;
      const recentExpense = now >= snapshot.lastExpenseAt && now - snapshot.lastExpenseAt < 4000;
      const pose = now < caughtUntil ? 'caught' : 'eat';
      const messages = { idle: '再吃一口就收工。', scoop: '饭钱到账，开饭。', bite: '我就吃一小口。', chew: '嚼嚼嚼…', peek: '你还在忙呀？', caught: '饭自己跑嘴里的。', wipe: '一点都没浪费。', full: '今天也吃饱啦。', sleep: '抱着饭碗歇一会儿…' };
      const expanded = snapshot.view.expanded;
      const theme = ['light', 'gold'].includes(snapshot.view.theme) ? snapshot.view.theme : 'dark';
      const palette = theme === 'light'
        ? { '--sm-bg': '#f7f8fa', '--sm-text': '#1f2329', '--sm-muted': '#6b7280', '--sm-line': '#00000014', '--dsw-specific-bubble': '#dfe7f7' }
        : theme === 'gold'
          ? { '--sm-bg': '#1f1a13', '--sm-text': '#d6b36a', '--sm-muted': '#9c8a63', '--sm-line': '#ffffff14', '--dsw-specific-bubble': '#3a2f1d', '--sm-blue': '#c9a227' }
          : { '--sm-bg': '#232324', '--sm-text': '#e9ebf2', '--sm-muted': '#9398a6', '--sm-line': '#ffffff17', '--dsw-specific-bubble': '#34436c' };
      const clockText = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
      const money = value => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const expenseText = expenses > 0 && expenses < 0.01 ? expenses.toFixed(4) : money(expenses);
      const feeDescription = '按已识别的 DeepSeek 官方模型 token 和 2026-11-03 单价估算。节假日调整、搜索抓取、辅助调用和第三方模型费用未纳入。';
      return createPortal(h('section', { ref: widget, 'data-salary-meter': true, 'data-expanded': expanded, 'data-theme': theme, className: 'sm-widget', 'aria-label': '打工养肥鱼', style: palette },
        h('div', { className: 'sm-top',
          onPointerDown: event => {
            if (event.target.closest('button')) return;
            const bounds = widget.current.getBoundingClientRect();
            drag.current = { x: event.clientX - bounds.x, y: event.clientY - bounds.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerMove: event => {
            if (!drag.current) return;
            manuallyPlaced.current = true;
            const left = Math.max(0, Math.min(innerWidth - widget.current.offsetWidth, event.clientX - drag.current.x));
            const top = Math.max(0, Math.min(innerHeight - widget.current.offsetHeight, event.clientY - drag.current.y));
            Object.assign(widget.current.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
          },
          onPointerUp: () => { drag.current = null; },
          onPointerCancel: () => { drag.current = null; },
        },
          h('span', { className: 'sm-title', title: wage.status }, '碗里还剩'),
          h('time', { className: 'sm-clock' }, clockText),
          h(Button, { size: 'sm', variant: 'ghost', title: '设置', 'aria-label': '设置', onClick: () => setSettingsOpen(true) }, '⋯')),
        h('div', { className: 'sm-balance', title: partial ? '部分调用费用待支持，余额为上限估算' : '当日工资减去已统计的模型费用估算' },
          h('small', null, partial ? '≤ ¥' : '≈ ¥'), h('span', { style: { '--sm-digits': money(amount).length } }, money(amount)),
          h(Button, { className: 'sm-toggle', size: 'sm', variant: 'ghost', disabled: savingView, 'aria-label': expanded ? '收起人物' : '展开人物', 'aria-expanded': expanded, 'aria-controls': 'salary-meter-character', onClick: toggleView }, expanded ? '收起 ⌄' : '展开 ⌃')),
        expanded && h('div', { id: 'salary-meter-character' },
          // The canvas owns its 30 FPS clock; the salary UI does not re-render per frame.
          h('button', { className: `sm-mascot sm-${pose}`, title: '发现她偷吃', 'aria-label': '发现鲸鱼娘偷吃', onClick: () => setCaughtUntil(Date.now() + 2500) },
            h(WhaleMascot, { caught: pose === 'caught', busy: snapshot.active > 0 || recentExpense, onAction: setMascotAction })),
          h('div', { className: 'sm-bubble' }, pose === 'caught' ? messages.caught : messages[mascotAction] || messages.idle)),
        h('div', { className: 'sm-worktime' },
          h('div', { className: 'sm-worktime-row' },
            h('span', null, wage.countdownLabel, ' ', h('b', null, wage.countdownSeconds > 0 ? core.formatDuration(wage.countdownSeconds) : '')),
            expanded ? h('span', null, `进度 ${Math.round(wage.progress * 100)}%`) : h('span', { className: 'sm-compact-expense', title: feeDescription }, `偷吃 ${partial ? '≥' : '≈'}¥${expenseText}${partial ? ' 有遗漏' : ''}`)),
          expanded && h('progress', { value: wage.progress, max: 1, 'aria-label': '今日工作进度' })),
        expanded && h('div', { className: 'sm-ledger' },
          h('div', null, h('label', null, '今日打工入账'), h('b', null, `¥${money(wage.earned)}`)),
          h('div', { className: 'sm-expense', title: feeDescription }, h('label', null, partial ? '偷吃估算（有遗漏）' : '今日肥鱼偷吃（估算）'), h('b', null, `${partial ? '≥' : '−'} ¥${expenseText}`))),
        error && h('p', { className: 'sm-error', role: 'alert' }, error),
        settingsOpen && h('dialog', { ref: dialog, className: 'sm-settings', onClose: () => setSettingsOpen(false) },
          h('button', { className: 'sm-close', 'aria-label': '关闭参数设置', onClick: () => dialog.current.close() }, '×'),
          h('iframe', { src: '/api/salary-meter/settings', title: '设置' }))), document.body);
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
