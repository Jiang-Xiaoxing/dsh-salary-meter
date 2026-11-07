/*
 * Tauri 适配层：把 Tauri 的 invoke / event 包装成和 Electron preload 一致的 window.api。
 * 在 Electron 里 window.api 已由 preload 注入，__TAURI__ 不存在，本文件不做任何事。
 */
(function () {
  'use strict';

  if (!window.__TAURI__ || !window.__TAURI__.core) return;

  var invoke = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;

  window.api = {
    getConfig: function () {
      return invoke('get_config');
    },
    setConfig: function (patch) {
      return invoke('set_config', { patch: patch });
    },
    onConfig: function (cb) {
      listen('config-changed', function (e) { cb(e.payload); });
    },
    onPassthrough: function (cb) {
      listen('passthrough', function (e) { cb(e.payload); });
    },
    getState: function () {
      return invoke('get_state');
    },
    recompute: function () {
      return invoke('recompute_today');
    },
    setExpanded: function (expanded) {
      return invoke('set_expanded', { expanded: !!expanded });
    },
    setMode: function (mode) {
      return invoke('set_mode', { mode: mode });
    },
    onOpenSettings: function (cb) {
      listen('open-settings', function () { cb(); });
    },
    openSettings: function () {
      invoke('open_settings');
    },
    openMenu: function () {
      invoke('open_menu');
    }
  };

  // Tauri 的拖拽区必须逐元素标记，不像 Electron 的 CSS 区域能继承
  window.addEventListener('DOMContentLoaded', function () {
    var nodes = document.querySelectorAll(
      '[data-salary-meter], .sm-top, .sm-top span, .sm-top time, .sm-top b, ' +
      '.sm-worktime, .sm-worktime span, .sm-worktime b, ' +
      '.sm-ledger, .sm-ledger div, .sm-ledger label, .sm-ledger b, ' +
      '.sm-layer-bar, .sm-layer-bar span'
    );
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('data-tauri-drag-region', '');
    }

    /* 人物和账目条占了收起态的大半屏幕，它们必须是拖拽区。
       但直接标成 data-tauri-drag-region 会把点击吞掉（人物点一下是偷吃动画，
       账目条点一下是展开/收起），所以这里自己判断：按下后挪动超过 8px 才算拖窗口，
       只是轻点就放行给原来的 click。 */
    function draggable(node) {
      if (!node) return;
      var sx = null;
      var sy = null;
      var armed = false;
      var suppressClick = false;
      node.addEventListener('click', function (e) {
        if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false; }
      }, true);
      node.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        // 点在按钮上就别当拖动，交给原来的 click
        var button = e.target.closest && e.target.closest('button');
        if (button && button !== node) return;
        suppressClick = false;
        sx = e.screenX;
        sy = e.screenY;
        armed = true;
      });
      window.addEventListener('mousemove', function (e) {
        if (!armed || sx === null) return;
        // 阈值放宽到 8px，手抖不算拖
        if (Math.abs(e.screenX - sx) < 8 && Math.abs(e.screenY - sy) < 8) return;
        armed = false;
        sx = null;
        sy = null;
        suppressClick = true;
        invoke('set_dragging', { dragging: true })
          .then(function () { return invoke('start_pet_drag'); })
          .catch(function (error) {
            console.error('窗口拖动失败', error);
            invoke('set_dragging', { dragging: false }).catch(console.error);
          });
      });
      window.addEventListener('mouseup', function () {
        armed = false;
        sx = null;
        sy = null;
      });
    }

    draggable(document.querySelector('.sm-mascot'));
    // 金额区也能拖（用户 12:03 反馈拖这里没反应），但按在按钮上时不拖
    draggable(document.getElementById('balanceRow'));

    // 松手就解除「正在拖」，比等 1.5 秒超时更快
    window.addEventListener('mouseup', function () {
      try { window.__TAURI__.core.invoke('set_dragging', { dragging: false }); } catch (err) {}
    });
  });
})();
