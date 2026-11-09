const $=s=>document.querySelector(s), invoke=window.__TAURI__?.core.invoke;
const money=v=>'¥'+Math.abs(v).toFixed(2);
let bill,timers=[],when='昨天',title='昨日账单';
function dayLabel(day){
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
 const d=new Date(day+'T00:00:00+08:00'), t=new Date(today+'T00:00:00+08:00');
 const ago=Math.round((t-d)/86400000);
 if(ago===1)return {when:'昨天',title:'昨日账单'};
 if(ago===0)return {when:'今天',title:'今日账单'};
 return {when:(()=>{const [,m,d]=day.split('-').map(Number);return m+' 月 '+d+' 日';})(),title:'补记的账单'};
}
function closeWindow(){return window.__TAURI__?.window.getCurrentWindow().close();}
async function accept(){
 if(!bill)return;
 try{if(invoke)await invoke('dismiss_settlement',{day:bill.day});else document.body.dataset.closed='true';}
 catch(e){$('#error').textContent='保存失败，请再试一次：'+e;}
}
async function hide(){
 if(!bill)return;
 try{if(invoke)await invoke('hide_settlement',{day:bill.day});else document.body.dataset.closed='true';}
 catch(e){try{await closeWindow()}catch(_){$('#error').textContent='关闭失败：'+e;}}
}
$('#close').onclick=hide;$('#accept').onclick=accept;
document.addEventListener('keydown',e=>{if(e.key==='Escape')hide()});
function phase(n){
 const zero=bill.income===0,spent=bill.expense>0;
 const deficit=Math.round(bill.expense*100)>Math.round(bill.income*100);
 const empty=zero&&!spent,quiet=!zero&&!spent;
 $('.stage').dataset.phase=n;
 const pose=zero||deficit&&n===2?3:n;
 $('#pet').style.backgroundPosition=(pose*100/3)+'% center';
 if(empty){$('#pet').style.backgroundImage='none';if(!$('#pet video')){$('#pet').innerHTML='<video src="assets/webm/idle.webm" autoplay muted loop playsinline style="width:100%;height:100%;object-fit:contain"></video>';}}
 $('#bubble').textContent=empty?when+'一起歇业啦。'
  :zero?[when+'没有工资进账。','不过…我还是吃了点。',when+'的饭钱在这里。'][n]
  :quiet?[when+'一分钱没花。','我乖乖省着呢。','账本都给你看！'][n]
  :deficit&&n===2?when+'吃得有点多…'
  :[when+'也辛苦啦！','我的饭钱…就一点点。','这些都给你！'][n];
 $('#tokens').innerHTML=n===0&&!zero?'<i>T</i><i style="animation-delay:.5s;left:34%">T</i>':'';
 $('#income').textContent=(bill.income?'+':'')+money(bill.income);
 $('#expense').textContent=n>=1?'−'+money(bill.expense):'…';
 $('#net').textContent=n>=2?money(bill.income-bill.expense):'…';
 $('#label').textContent=(when==='昨天'?'昨日':when==='今天'?'今日':'')+(deficit?'净支出':'剩余');
 $('#accept').textContent=zero||deficit?'知道啦':'收下啦';
}
try{
 bill=invoke?await invoke('settlement_bill'):window.__SETTLEMENT_PREVIEW__||{day:'2026-11-09',income:200,expense:12.5,unknown:0};
 const label=dayLabel(bill.day);when=label.when;title=label.title;
 $('#date').textContent=bill.day+' · '+title;
 $('#note').textContent=bill.unknown?`工资与饭钱均为估算 · ${bill.unknown} 笔费用尚未计入`:'工资与饭钱均为估算';
 phase(0);timers.push(setTimeout(()=>phase(1),3000),setTimeout(()=>phase(2),6000));
}catch(e){$('#error').textContent='账单读取失败：'+e;$('#close').onclick=()=>closeWindow();}
window.addEventListener('pagehide',()=>timers.forEach(clearTimeout));
