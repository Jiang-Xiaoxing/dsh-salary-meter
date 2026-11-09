//! 午夜结算：固定北京时间；先保存账单，再展示，明确关闭后才标记已读。
use super::*;
static LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
pub struct Bill { day: String, income: f64, expense: f64, unknown: u64 }
#[derive(Serialize, Deserialize)]
struct Book { day: String, config: Config, pending: Option<Bill>, history: Vec<Bill> }
fn save(app: &AppHandle, book: &Book) -> Result<(), String> {
    fs::create_dir_all(data_dir(app)).map_err(|e|e.to_string())?;
    let p=data_dir(app).join("settlements.json");
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
#[tauri::command(async)]
pub fn poll_settlement(app: AppHandle) -> Result<(),String> {
    let _guard=LOCK.lock().map_err(|e|e.to_string())?;
    let now=ledger::now_ms();let day=ledger::beijing_day(now);let cfg=load_config(&app);
    let p=data_dir(&app).join("settlements.json");
    let mut book:Book=match fs::read(&p){Ok(bytes)=>serde_json::from_slice(&bytes).map_err(|e|format!("结算记录无法读取：{e}"))?,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{let b=Book{day,config:cfg,pending:None,history:vec![]};return save(&app,&b)},Err(e)=>return Err(e.to_string())};
    if day>book.day {
        // 正在看的账单不在背后替换，用户关闭后下一次检查再生成新账单。
        if app.get_webview_window("settlement").is_some(){return Ok(())}
        let yesterday=ledger::day_start_ms(now)-1;
        let target=ledger::beijing_day(yesterday);
        let report=ledger::scan_at(&app.state::<AppState>().prices,&mut ledger::ScanCache::default(),&dsh_home(),yesterday);
        let bill=Bill{day:target,income:income(&book.config,yesterday),expense:report.today.expense,unknown:report.today.unknown};
        book.history.push(bill.clone());book.pending=Some(bill);book.day=day;
        book.config=cfg;save(&app,&book)?;
    } else if book.day==day && serde_json::to_value(&book.config).ok()!=serde_json::to_value(&cfg).ok(){book.config=cfg;save(&app,&book)?;}
    if book.pending.is_some() && app.get_webview_window("settlement").is_none(){
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
    let b:Book=serde_json::from_slice(&fs::read(data_dir(&app).join("settlements.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    b.pending.ok_or_else(||"没有待结算账单".into())
}
#[tauri::command]
pub fn dismiss_settlement(app: AppHandle, day:String)->Result<(),String>{
    let _g=LOCK.lock().map_err(|e|e.to_string())?;
    let mut b:Book=serde_json::from_slice(&fs::read(data_dir(&app).join("settlements.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if b.pending.as_ref().map(|v|v.day.as_str())!=Some(day.as_str()){return Err("账单已变化，请重新打开".into())}
    b.pending=None;save(&app,&b)?;
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
    let book=Book{day:"2026-11-09".into(),config:Config::default(),pending:Some(b.clone()),history:vec![b]};
    let mut restored:Book=serde_json::from_slice(&serde_json::to_vec(&book).unwrap()).unwrap();
    assert_eq!(restored.pending.as_ref().unwrap().expense,12.5); restored.pending=None;
    let saved:Book=serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
    assert!(saved.pending.is_none());assert_eq!(saved.history.len(),1);
 }
}
