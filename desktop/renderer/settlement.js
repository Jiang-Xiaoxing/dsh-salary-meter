const $=s=>document.querySelector(s), invoke=window.__TAURI__?.core.invoke;
const money=v=>'¥'+Math.abs(v).toFixed(2);
let bill,timers=[];
async function dismiss(){if(!bill)return;try{if(invoke)await invoke('dismiss_settlement',{day:bill.day});else document.body.dataset.closed='true';}catch(e){$('#error').textContent='保存失败，请再试一次：'+e;}}
$('#close').onclick=dismiss;$('#accept').onclick=dismiss;document.addEventListener('keydown',e=>{if(e.key==='Escape')dismiss()});
function phase(n){
 const zero=bill.income===0,deficit=bill.expense>bill.income,empty=zero&&bill.expense===0;
 $('.stage').dataset.phase=n;
 const pose=zero||deficit&&n===2?3:n;
 $('#pet').style.backgroundPosition=(pose*100/3)+'% center';
 if(empty){$('#pet').style.backgroundImage='none';if(!$('#pet video')){$('#pet').innerHTML='<video src="assets/webm/idle.webm" autoplay muted loop playsinline style="width:100%;height:100%;object-fit:contain"></video>';}}
 $('#bubble').textContent=empty?'今天一起歇业啦。':zero?['今天没有工资进账。','不过…我还是吃了点。','今天的饭钱在这里。'][n]:deficit&&n===2?'今天吃得有点多…': ['今天也辛苦啦！','我的饭钱…就一点点。','这些都给你！'][n];
 $('#tokens').innerHTML=n===0&&!zero?'<i>T</i><i style="animation-delay:.5s;left:34%">T</i>':'';
 $('#income').textContent=(bill.income?'+':'')+money(bill.income);
 $('#expense').textContent=n>=1?'−'+money(bill.expense):'…';
 $('#net').textContent=n>=2?money(bill.income-bill.expense):'…';
 $('#label').textContent=deficit?'昨日净支出':'昨日剩余';
 $('#accept').textContent=zero||deficit?'知道啦':'收下啦';
}
try{
 bill=invoke?await invoke('settlement_bill'):window.__SETTLEMENT_PREVIEW__||{day:'2026-11-09',income:200,expense:12.5,unknown:0};
 $('#date').textContent=bill.day+' · 昨日账单';
 $('#note').textContent=bill.unknown?`工资与饭钱均为估算 · ${bill.unknown} 笔费用尚未计入`:'工资与饭钱均为估算';
 phase(0);timers.push(setTimeout(()=>phase(1),3000),setTimeout(()=>phase(2),6000));
}catch(e){$('#error').textContent='账单读取失败：'+e;$('#close').onclick=()=>window.__TAURI__?.window.getCurrentWindow().close();}
window.addEventListener('pagehide',()=>timers.forEach(clearTimeout));
