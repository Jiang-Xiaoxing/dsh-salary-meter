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
  });
})();
