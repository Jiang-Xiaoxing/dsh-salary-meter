//! 午夜结算：固定北京时间；先保存账单，再展示，明确点「收下」才标记已读。
//! 点 × / Esc 只关窗口、不清账单：本次运行不再自动弹，下次启动还会弹。
use super::*;
static LOCK: Mutex<()> = Mutex::new(());
/// 本次运行里被用户手动关掉过的账单（按日期记）。换了新账单自然失效，不用清。
static HIDDEN: Mutex<Option<String>> = Mutex::new(None);
#[derive(Clone, Serialize, Deserialize)]
pub struct Bill { day: String, income: f64, expense: f64, unknown: u64 }
#[derive(Serialize, Deserialize)]
struct Book {
    day: String,
    config: Config,
    pending: Option<Bill>,
    /// 跨天时旧账单还没点「收下」：新账单排这里，等旧的收下再依次弹，不覆盖也不丢。
    #[serde(default)]
    queued: Vec<Bill>,
    history: Vec<Bill>,
}
fn empty_book(cfg: Config) -> Book { Book{day:String::new(),config:cfg,pending:None,queued:vec![],history:vec![]} }
fn book_file(app: &AppHandle) -> std::path::PathBuf { data_dir(app).join("settlements.json") }
fn save(app: &AppHandle, book: &Book) -> Result<(), String> {
    fs::create_dir_all(data_dir(app)).map_err(|e|e.to_string())?;
    let p=book_file(app);
    let tmp=p.with_extension("tmp");
    fs::write(&tmp,serde_json::to_vec_pretty(book).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    fs::rename(tmp,p).map_err(|e|e.to_string())
}
fn income(cfg: &Config, stamp: i64) -> f64 {
    let days=(stamp+28_800_000).div_euclid(86_400_000);
    let wd=(days+4).rem_euclid(7);
    let mode=if cfg.rest_mode.is_empty(){if cfg.weekend{"none"}else{"double"}}else{&cfg.rest_mode};
    let week=(days-20458).div_euclid(7); // 2026-01-05
    let rest=match mode {"none"=>false,"single"=>wd==0,"alternate"=>wd==0||(wd==6&&week.rem_euclid(2)==0),_=>wd==0||wd==6};
    let hm=|s:&str|->f64 {let mut p=s.split(':');p.next().and_then(|v|v.parse::<f64>().ok()).unwrap_or(0.)*60.+p.next().and_then(|v|v.parse::<f64>().ok()).unwrap_or(0.)};
    if rest || hm(&cfg.end)-hm(&cfg.start)-cfg.lunch*60.<=0. {0.}else{(cfg.salary.max(0.)/cfg.days.max(1.)*100.).round()/100.}
}
/// 扫「昨天」生成一张账单。
fn scan_bill(app: &AppHandle, cfg: &Config, now: i64) -> Bill {
    let yesterday=ledger::day_start_ms(now)-1;
    let target=ledger::beijing_day(yesterday);
    let report=ledger::scan_at(&app.state::<AppState>().prices,&mut ledger::ScanCache::default(),&dsh_home(),yesterday);
    Bill{day:target,income:income(cfg,yesterday),expense:report.today.expense,unknown:report.today.unknown}
}
/// 读账本。文件坏了先留一份证据、重建空账本，别让结算功能永久失效。
/// 备份失败就不动原文件直接报错，免得把损坏内容覆盖掉。
/// 第一次运行返回 day 为空，由 poll 决定补不补昨天的账单。
fn load_book(app: &AppHandle) -> Result<Book, String> {
    let p=book_file(app);
    match fs::read(&p) {
        Ok(bytes)=>match serde_json::from_slice::<Book>(&bytes) {
            Ok(b)=>Ok(b),
            Err(e)=>{
                let bad=data_dir(app).join(format!("settlements.corrupt-{}.json",ledger::now_ms()));
                if let Err(re)=fs::rename(&p,&bad).or_else(|_|fs::copy(&p,&bad).map(|_|())) {
                    return Err(format!("结算记录损坏（{e}），备份到 {} 也失败（{re}），先不动原文件",bad.display()));
                }
                eprintln!("结算记录损坏（{e}），已备份到 {}",bad.display());
                let b=empty_book(load_config(app));
                save(app,&b)?;
                Ok(b)
            }
        },
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(empty_book(load_config(app))),
        Err(e)=>Err(e.to_string()),
    }
}
#[tauri::command(async)]
pub fn poll_settlement(app: AppHandle) -> Result<(),String> {
    let _guard=LOCK.lock().map_err(|e|e.to_string())?;
    let now=ledger::now_ms();let day=ledger::beijing_day(now);let cfg=load_config(&app);
    let mut book=load_book(&app)?;let mut changed=false;
    if book.day.is_empty() {
        // 第一次运行（或账本刚重建）：补昨天的账单，但昨天真的一点数都没有就不打扰。
        let bill=scan_bill(&app,&cfg,now);
        if bill.income!=0. || bill.expense!=0. || bill.unknown!=0 {
            book.history.push(bill.clone());book.pending=Some(bill);
        }
        book.day=day;book.config=cfg;changed=true;
    } else if day>book.day {
        // 跨天：用上一次保存的配置算昨天，用户今天改的工资不该倒回去重算旧账。
        let bill=scan_bill(&app,&book.config,now);
        book.history.push(bill.clone());
        if book.pending.is_none() {book.pending=Some(bill);} else {book.queued.push(bill);}
        book.day=day;book.config=cfg;changed=true;
    } else if book.day==day && serde_json::to_value(&book.config).ok()!=serde_json::to_value(&cfg).ok(){
        book.config=cfg;changed=true;
    }
    if changed {save(&app,&book)?;}
    let hidden=HIDDEN.lock().map_err(|e|e.to_string())?.clone();
    let pending=book.pending.as_ref().map(|b|b.day.clone());
    if pending.is_some() && pending!=hidden && app.get_webview_window("settlement").is_none() {
        let (width,height)=app.get_webview_window("main").and_then(|w|w.current_monitor().ok().flatten()).map(|m|{
            let scale=m.scale_factor();let area=m.work_area();
            (620f64.min(area.size.width as f64/scale-40.),760f64.min(area.size.height as f64/scale-40.))
        }).unwrap_or((620.,760.));
        tauri::WebviewWindowBuilder::new(&app,"settlement",tauri::WebviewUrl::App("settlement.html".into()))
            .title("午夜结算").inner_size(width,height).min_inner_size(360.,460.).decorations(false)
            .resizable(true).always_on_top(true).center().build().map_err(|e|e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn settlement_bill(app: AppHandle)->Result<Bill,String>{
    let _g=LOCK.lock().map_err(|e|e.to_string())?;
    let b=load_book(&app)?;
    b.pending.ok_or_else(||"没有待结算账单".into())
}
/// 点 × / Esc：只关窗口，不标已读。本次运行不再自动弹这张，重启后还会弹。
/// 和 poll 共用 LOCK：正在建窗时点 ×，会等建完再关，不会出现「关了又弹」。
/// 用 async 命令，poll 持锁扫账本时点 × 不会卡住界面。
#[tauri::command(async)]
pub fn hide_settlement(app: AppHandle, day: String)->Result<(),String>{
    let _g=LOCK.lock().map_err(|e|e.to_string())?;
    *HIDDEN.lock().map_err(|e|e.to_string())?=Some(day);
    if let Some(w)=app.get_webview_window("settlement"){w.close().map_err(|e|e.to_string())?;} Ok(())
}
/// 点「收下」：这才算读过，清掉这张；排队里还有就换上下一张，下次轮询会弹出来。
#[tauri::command(async)]
pub fn dismiss_settlement(app: AppHandle, day:String)->Result<(),String>{
    let _g=LOCK.lock().map_err(|e|e.to_string())?;
    let mut b=load_book(&app)?;
    if b.pending.as_ref().map(|v|v.day.as_str())!=Some(day.as_str()){return Err("账单已变化，请重新打开".into())}
    b.pending=if b.queued.is_empty(){None}else{Some(b.queued.remove(0))};
    save(&app,&b)?;
    if let Some(w)=app.get_webview_window("settlement"){w.close().map_err(|e|e.to_string())?;} Ok(())
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn work_and_rest(){let c=Config::default();assert_eq!(income(&c,1794211199000),227.27);assert_eq!(income(&c,1794124799000),0.);}
 #[test] fn no_work_duration(){let mut c=Config::default();c.end=c.start.clone();assert_eq!(income(&c,1794211199000),0.);}
 #[test] fn modes_and_year_boundary(){
    let mut c=Config::default(); let saturday=1794038399000;
    c.rest_mode="none".into();assert_eq!(income(&c,saturday),227.27);
    c.rest_mode="single".into();assert_eq!(income(&c,saturday),227.27);
    c.rest_mode="double".into();assert_eq!(income(&c,saturday),0.);
    assert_eq!(ledger::beijing_day(ledger::day_start_ms(1798732800000)-1),"2026-12-31");
 }
 #[test] fn bill_roundtrip_keeps_pending_and_history(){
    let b=Bill{day:"2026-11-08".into(),income:0.,expense:12.5,unknown:2};
    let book=Book{day:"2026-11-09".into(),config:Config::default(),pending:Some(b.clone()),queued:vec![],history:vec![b]};
    let restored:Book=serde_json::from_slice(&serde_json::to_vec(&book).unwrap()).unwrap();
    assert_eq!(restored.pending.as_ref().unwrap().expense,12.5);
 }
 #[test] fn empty_day_means_first_run(){let b:Book=serde_json::from_slice(&serde_json::to_vec(&empty_book(Config::default())).unwrap()).unwrap();assert!(b.day.is_empty());assert!(b.queued.is_empty());}
 #[test] fn queued_bills_advance_after_dismiss(){
    let a=Bill{day:"2026-11-07".into(),income:1.,expense:2.,unknown:0};
    let b=Bill{day:"2026-11-08".into(),income:3.,expense:4.,unknown:0};
    let mut book=Book{day:"2026-11-09".into(),config:Config::default(),pending:Some(a.clone()),queued:vec![b.clone()],history:vec![a,b]};
    let restored:Book=serde_json::from_slice(&serde_json::to_vec(&book).unwrap()).unwrap();
    assert_eq!(restored.queued.len(),1);
    book.pending=if book.queued.is_empty(){None}else{Some(book.queued.remove(0))};
    assert_eq!(book.pending.as_ref().unwrap().day,"2026-11-08");
    assert!(book.queued.is_empty());
 }
}
