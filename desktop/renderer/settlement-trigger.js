(() => {
  if (!window.__TAURI__) return;
  let busy = false;
  async function check() {
    if (busy) return;
    busy = true;
    try { await window.__TAURI__.core.invoke('poll_settlement'); }
    catch (e) { console.error('结算检查失败', e); }
    finally { busy = false; }
  }
  check(); setInterval(check, 1000);
})();
