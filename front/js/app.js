/* ═══════════════════════════════════════════════
   CallMind v27 — Bitrix24 App
   Fixes & Features:
   1. Мультивыбор звонков + групповая проверка по скрипту
   2. Отступы в модалках выровнены
   3. Сортировка звонков от новых к старым
   4. Резюме на вкладке Обзор (после тональности)
   5. Темы/теги только на русском (промпт)
   6. После проверки по скрипту — обновляем score звонка
   7. CRM-ссылки рядом с номером (контакт/лид/сделка/компания)
   8. Фильтр сотрудников — только из allowedUsers
   9. Исправлен ReferenceError: grm → crm; убран двойной lookupCrm
      telephony.externalcall.finish — не вызываем при ошибке 400
═══════════════════════════════════════════════ */
var App = (function () {

  /* ─── CONFIG ─── */
  var cfg = {
    serverMode:   'worker',   // 'worker' | 'vds'
    cfUrl:        '',          // Cloudflare Worker URL
    vdsUrl:       '',          // VDS server URL
    vdsApiKey:    '',          // VDS API key (x-api-key header)
    dsModel:      'deepseek-chat',
    whisperLang:  'ru',
    tgSaveBx:     '1',
    tgAlertNeg:   '0',
    allowedUsers:    null,
    crmEntityTypes:  []
  };
  var LS_KEY = 'callmind_cfg_v32';
  var LS_ANA = 'callmind_analyses_v32';
  var LS_SCR = 'callmind_scripts_v32';
  var LS_FUNNEL = 'callmind_funnel_v32'; // сохранённый фильтр воронок для пользователя

  function saveCfg() {
    try {
      var data = JSON.parse(JSON.stringify(cfg));
      data.minDuration = activeFilters.minDuration;
      delete data.allowedUsers;
      delete data.crmEntityTypes;
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch(e){}
  }
  function saveFunnelFilter(stages) {
    try { localStorage.setItem(LS_FUNNEL, JSON.stringify(stages||[])); } catch(e){}
  }
  function loadFunnelFilter() {
    try { var r=localStorage.getItem(LS_FUNNEL); return r?JSON.parse(r):[]; } catch(e){ return []; }
  }
  function loadCfg() {
    try {
      var r = localStorage.getItem(LS_KEY); if(!r) return;
      var s = JSON.parse(r);
      ['cfUrl','vdsUrl','vdsApiKey','dsModel','whisperLang','tgSaveBx','tgAlertNeg','serverMode'].forEach(function(k){
        if(s[k]!=null) cfg[k]=String(s[k]);
      });
      if(s.minDuration!=null) activeFilters.minDuration=parseInt(s.minDuration)||0;
    } catch(e){}
    // Восстанавливаем фильтр воронок
    var saved = loadFunnelFilter();
    if(saved.length) activeFilters.funnelStages = saved;
  }
  function saveAnalysis(id, a) {
    try {
      var r=localStorage.getItem(LS_ANA); var store=r?JSON.parse(r):{};
      store[id]=a;
      var keys=Object.keys(store);
      if(keys.length>500) keys.slice(0,keys.length-500).forEach(function(k){delete store[k];});
      localStorage.setItem(LS_ANA, JSON.stringify(store));
    } catch(e){}
  }
  function loadAnalyses() { try{var r=localStorage.getItem(LS_ANA);return r?JSON.parse(r):{};} catch(e){return{};} }
  function loadScripts()   { try{var r=localStorage.getItem(LS_SCR);return r?JSON.parse(r):[];} catch(e){return[];} }
  function saveScripts(s)  { try{localStorage.setItem(LS_SCR,JSON.stringify(s));}catch(e){} }

  /* ─── STATE ─── */
  var allLoadedCalls = [];
  var calls = [];
  var allManagers = [];
  var allDepts = [];
  var crmCache = {};  // phone_normalized → {type,id,name} | null
  var activeFilters = { dateFrom:null, dateTo:null, dateLabel:'Последние 7 дней', datePreset:'7days', managers:[], hasRecord:true, sentiment:'', minDuration:10, funnelStages:[] };
  var draftDate = { from:null, to:null, preset:'7days' };
  var draftManagers = [];
  var draftFunnelStages = [];   // черновик выбора воронок в модале
  var allFunnels = [];           // [{id, name, type:'lead'|'deal', stages:[{id,name}]}]
  var crmStageCache = {};        // crmId → {funnelName, stageName}
  var currentPage = 0;
  var PAGE_SIZE = 50;

  /* ─── MULTI-SELECT STATE ─── */
  var selectedCallIds = [];  // массив выбранных id

  /* ─── MODAL STATE ─── */
  var modalCallId = null;
  var modalActiveTab = 'overview';
  var modalScriptCheckResult = null;

  /* ─── BACKGROUND SCRIPT CHECK JOBS ─── */
  // { [callId]: { status:'running'|'done'|'error', checkResult, scriptId } }
  var bgScriptJobs = {};

  /* ══════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════ */
  function init() {
    calcPreset('7days', draftDate);
    activeFilters.dateFrom = draftDate.from;
    activeFilters.dateTo   = draftDate.to;

    BX24.init(function() {
      BX24.callMethod('user.current', {}, function(res) {
        if(res && !res.error() && res.data()) {
          var u = res.data();
          setText('topbarUser', ((u.LAST_NAME||'')+' '+(u.NAME||'')).trim());
          setText('portalInfo', BX24.getDomain ? BX24.getDomain() : '');
        }
      });
      loadCfg(); loadSettingsUI(); checkCFStatus();

      var _bx24OptsReady = false;
      var _managersReady = false;
      function _onBothReady() {
        if(!_bx24OptsReady || !_managersReady) return;
        renderSettingsDeptList();
        loadFunnelsFromBX24();
        loadCallsFromBX24();
      }

      var bx24Keys = ['serverMode','cfUrl','vdsUrl','dsModel','whisperLang','tgSaveBx','tgAlertNeg','minDuration','allowedUsers','crmEntityTypes'];
      var bx24Loaded = 0;
      var bx24Opts = {};
      function _onAllKeysLoaded() {
        bx24Loaded++;
        if(bx24Loaded < bx24Keys.length) return;
        ['serverMode','cfUrl','vdsUrl','dsModel','whisperLang','tgSaveBx','tgAlertNeg'].forEach(function(k){
          if(bx24Opts[k]!=null&&bx24Opts[k]!=='') cfg[k]=String(bx24Opts[k]);
        });
        if(bx24Opts.minDuration!=null&&bx24Opts.minDuration!=='') activeFilters.minDuration=parseInt(bx24Opts.minDuration)||0;
        if(bx24Opts.allowedUsers!=null&&bx24Opts.allowedUsers!=='') {
          try { cfg.allowedUsers = JSON.parse(bx24Opts.allowedUsers); } catch(e) {}
        }
        if(bx24Opts.crmEntityTypes!=null&&bx24Opts.crmEntityTypes!=='') {
          try { cfg.crmEntityTypes = JSON.parse(bx24Opts.crmEntityTypes); } catch(e) {}
        }
        saveCfg(); loadSettingsUI(); checkCFStatus();
        _bx24OptsReady = true;
        _onBothReady();
      }
      bx24Keys.forEach(function(key) {
        BX24.callMethod('user.option.get', {option: key}, function(res) {
          if(res && !res.error()) bx24Opts[key] = res.data();
          _onAllKeysLoaded();
        });
      });

      loadDeptsAndUsers(function() {
        _managersReady = true;
        _onBothReady();
      });
    });

    bindNav(); bindModals(); bindFilters(); bindScriptsPage(); bindBulkBar(); bindModeSwitch(); bindFunnelFilter();
    updateScriptsBadge();
  }

  /* ══════════════════════════════════════════════
     NAVIGATION
  ══════════════════════════════════════════════ */
  function bindNav() {
    document.querySelectorAll('[data-page]').forEach(function(el) {
      el.addEventListener('click', function(){ showPage(el.getAttribute('data-page')); });
    });
  }
  function showPage(id) {
    document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
    var p=document.getElementById('page-'+id); if(p) p.classList.add('active');
    document.querySelectorAll('.tnav-item').forEach(function(n){ n.classList.remove('active'); });
    var nav=document.querySelector('.tnav-item[data-page="'+id+'"]'); if(nav) nav.classList.add('active');
    if(id==='analytics') renderAnalytics();
    if(id==='settings')  { loadSettingsUI(); renderSettingsDeptList(); renderSettingsFunnelList(); }
    if(id==='scripts')   renderScriptsList();
  }

  /* ══════════════════════════════════════════════
     LOAD USERS & DEPTS
  ══════════════════════════════════════════════ */
  function loadDeptsAndUsers(cb) {
    var wUrl = getActiveServerUrl();
    if(!wUrl) { if(cb) cb(); return; }
    _loadUsersPage(0, [], wUrl, cb);
  }
  function _loadUsersPage(start, collected, wUrl, cb) {
    var auth = BX24.getAuth();
    xhrPost(wUrl+'/bx24-users', {domain: auth.domain, token: auth.access_token, start: start}, 30000, function(err, res) {
      if(err) { if(cb) cb(); return; }
      if(start === 0 && res.departments && res.departments.length) {
        allDepts = res.departments.map(function(d){ return {id:String(d.ID), name:d.NAME||('#'+d.ID)}; });
      }
      collected = collected.concat(res.users || []);
      if(res.next != null) { _loadUsersPage(res.next, collected, wUrl, cb); return; }
      allManagers = collected.map(function(u) {
        var name = ((u.LAST_NAME||'')+' '+(u.NAME||'')).trim() || ('Пользователь #'+u.ID);
        var deptId = (u.UF_DEPARTMENT&&u.UF_DEPARTMENT.length) ? String(u.UF_DEPARTMENT[0]) : '';
        var dept = allDepts.find(function(d){ return d.id===deptId; });
        return { id:String(u.ID), name, deptId, deptName: dept?dept.name:'Без отдела' };
      });
      allManagers.sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });
      if(cb) cb();
    });
  }

  /* ══════════════════════════════════════════════
     CRM LOOKUP — fix: одиночный вызов, crm (не grm)
     Поиск по контактам, лидам, сделкам, компаниям
  ══════════════════════════════════════════════ */
  function lookupCrm(phone, cb) {
    if(!phone || phone==='—') { cb(null); return; }
    var norm = phone.replace(/\D/g,'');
    if(crmCache[norm] !== undefined) { cb(crmCache[norm]); return; }

    // Ищем сразу в нескольких сущностях через batch
    var batch = {
      contact: { method:'crm.contact.list', params:{ filter:{PHONE:phone}, select:['ID','NAME','LAST_NAME'], start:0 } },
      company: { method:'crm.company.list', params:{ filter:{PHONE:phone}, select:['ID','TITLE'], start:0 } },
      lead:    { method:'crm.lead.list',    params:{ filter:{PHONE:phone}, select:['ID','TITLE','NAME','LAST_NAME'], start:0 } }
    };

    BX24.callBatch(batch, function(results) {
      var result = null;

      // Приоритет: контакт → компания → лид
      var contactRes = results['contact'];
      if(contactRes && !contactRes.error()) {
        var items = contactRes.data()||[];
        if(items.length) {
          var c = items[0];
          var cName = ((c.LAST_NAME||'')+' '+(c.NAME||'')).trim()||('Контакт #'+c.ID);
          result = { type:'CONTACT', id:String(c.ID), name:cName, typeLabel:'Контакт' };
        }
      }
      if(!result) {
        var compRes = results['company'];
        if(compRes && !compRes.error()) {
          var items2 = compRes.data()||[];
          if(items2.length) result = { type:'COMPANY', id:String(items2[0].ID), name:items2[0].TITLE||('Компания #'+items2[0].ID), typeLabel:'Компания' };
        }
      }
      if(!result) {
        var leadRes = results['lead'];
        if(leadRes && !leadRes.error()) {
          var items3 = leadRes.data()||[];
          if(items3.length) {
            var l = items3[0];
            // Лид: TITLE — название лида; если нет — LAST_NAME + NAME
            var lName = (l.TITLE||'').trim() ||
                        ((l.LAST_NAME||'')+' '+(l.NAME||'')).trim() ||
                        ('Лид #'+l.ID);
            result = { type:'LEAD', id:String(l.ID), name:lName, typeLabel:'Лид' };
          }
        }
      }

      crmCache[norm] = result; // null или объект
      cb(result);
    });
  }

  function openCrmCard(crm) {
    if(!crm) return;
    var domain = BX24.getDomain ? BX24.getDomain() : window.location.hostname;
    var paths = { CONTACT:'crm/contact/details/', LEAD:'crm/lead/details/', COMPANY:'crm/company/details/', DEAL:'crm/deal/details/' };
    var path = paths[crm.type]; if(!path) return;
    window.open('https://'+domain+'/'+path+crm.id+'/', '_blank');
  }

  /* ══════════════════════════════════════════════
     LOAD CALLS — сортировка от новых к старым
  ══════════════════════════════════════════════ */
  function toBX24Date(d, end) {
    // voximplant.statistic.get принимает формат YYYY-MM-DD HH:MM:SS
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+(end?' 23:59:59':' 00:00:00');
  }

  /* ══════════════════════════════════════════════
     ВОРОНКИ — загрузка всех воронок + этапов из CRM
  ══════════════════════════════════════════════ */
  function loadFunnelsFromBX24() {
    var gen = ++loadFunnelsFromBX24._gen;
    // Шаг 1: загружаем категории сделок (воронки) и статусы лидов
    BX24.callBatch({
      dealCategories: { method:'crm.dealcategory.list', params:{ order:{SORT:'ASC'} } },
      leadStatuses:   { method:'crm.status.list',       params:{ filter:{ENTITY_ID:'STATUS'}, order:{SORT:'ASC'} } }
    }, function(res) {
      if(loadFunnelsFromBX24._gen !== gen) return;
      allFunnels = [];

      var cats = (res.dealCategories && !res.dealCategories.error()) ? (res.dealCategories.data()||[]) : [];
      var leadStages = (res.leadStatuses && !res.leadStatuses.error()) ? (res.leadStatuses.data()||[]) : [];

      // Лиды
      if(leadStages.length) {
        allFunnels.push({
          id:'lead', name:'Лиды', type:'lead', catId:'',
          stages: leadStages.map(function(s){ return {id:s.STATUS_ID, name:s.NAME}; })
        });
      }

      // Шаг 2: для каждой воронки (cat) нужен свой ENTITY_ID = DEAL_STAGE_<catId> (catId>0)
      // Общая воронка (catId=0) использует ENTITY_ID='DEAL_STAGE'
      // Остальные воронки: ENTITY_ID = 'DEAL_STAGE_<ID>'
      var batchReqs = {};
      batchReqs['stages_0'] = { method:'crm.status.list', params:{ filter:{ENTITY_ID:'DEAL_STAGE'}, order:{SORT:'ASC'} } };
      cats.forEach(function(cat) {
        var cid = String(cat.ID);
        batchReqs['stages_'+cid] = { method:'crm.status.list', params:{ filter:{ENTITY_ID:'DEAL_STAGE_'+cid}, order:{SORT:'ASC'} } };
      });

      BX24.callBatch(batchReqs, function(stageRes) {
        if(loadFunnelsFromBX24._gen !== gen) return;
        // Общая воронка
        var genStages = (stageRes['stages_0'] && !stageRes['stages_0'].error()) ? (stageRes['stages_0'].data()||[]) : [];
        if(genStages.length) {
          allFunnels.unshift({
            id:'deal_0', name:'Сделки: Общая воронка', type:'deal', catId:'0',
            stages: genStages.map(function(s){ return {id:s.STATUS_ID, name:s.NAME}; })
          });
        }

        // Дополнительные воронки (категории)
        cats.forEach(function(cat) {
          var cid = String(cat.ID);
          var stagesData = (stageRes['stages_'+cid] && !stageRes['stages_'+cid].error()) ? (stageRes['stages_'+cid].data()||[]) : [];
          allFunnels.push({
            id:'deal_'+cid, name:'Сделки: '+cat.NAME, type:'deal', catId:cid,
            stages: stagesData.map(function(s){ return {id:s.STATUS_ID, name:s.NAME}; })
          });
        });

        // Убираем воронки без этапов
        allFunnels = allFunnels.filter(function(f){ return f.stages.length > 0; });

        updateFunnelFilterLabel();
        // Если страница настроек открыта — обновляем список
        renderSettingsFunnelList();
      });
    });
  }
  loadFunnelsFromBX24._gen = 0;

  // Получить воронку+этап для CRM-объекта (из кэша или BX24)
  function lookupCrmStage(crm, cb) {
    if(!crm) { cb(null); return; }
    var key = crm.type+'_'+crm.id;
    if(crmStageCache[key] !== undefined) { cb(crmStageCache[key]); return; }

    if(crm.type==='LEAD') {
      BX24.callMethod('crm.lead.get', {id:crm.id, select:['STATUS_ID']}, function(r) {
        if(r.error()) { crmStageCache[key]=null; cb(null); return; }
        var d=r.data();
        var statusId = d.STATUS_ID;
        var funnel = allFunnels.find(function(f){ return f.type==='lead'; });
        var stage = funnel ? funnel.stages.find(function(s){ return s.id===statusId; }) : null;
        var result = stage ? {funnelName:'Лиды', stageName:stage.name} : null;
        crmStageCache[key]=result; cb(result);
      });
    } else if(crm.type==='DEAL') {
      BX24.callMethod('crm.deal.get', {id:crm.id, select:['STAGE_ID','CATEGORY_ID']}, function(r) {
        if(r.error()) { crmStageCache[key]=null; cb(null); return; }
        _resolveStageFromDeal(r.data(), key, cb);
      });
    } else { crmStageCache[key]=null; cb(null); }
  }

  function _resolveStageFromDeal(d, cacheKey, cb) {
    var catId = String(d.CATEGORY_ID||'0');
    var stageId = d.STAGE_ID;
    var funnel = allFunnels.find(function(f){ return f.type==='deal' && f.catId===catId; });
    var stage = funnel ? funnel.stages.find(function(s){ return s.id===stageId; }) : null;
    var result = (funnel&&stage) ? {funnelName:funnel.name.replace('Сделки: ',''), stageName:stage.name} : null;
    crmStageCache[cacheKey]=result; cb(result);
  }

  /* ── Фильтр по воронке/этапу ── */
  function bindFunnelFilter() {
    // Кнопки «Выбрать все» / «Сбросить» в настройках
    var selAll=document.getElementById('settingsFunnelSelectAll');
    var clrAll=document.getElementById('settingsFunnelClear');
    if(selAll) selAll.addEventListener('click', function(){
      draftFunnelStages = allFunnels.reduce(function(acc,f){
        f.stages.forEach(function(s){ acc.push(f.id+'::'+s.id); });
        return acc;
      },[]);
      renderSettingsFunnelList();
    });
    if(clrAll) clrAll.addEventListener('click', function(){
      draftFunnelStages=[];
      renderSettingsFunnelList();
    });
  }

  function openFunnelModal() {
    draftFunnelStages = activeFilters.funnelStages.slice();
    renderFunnelList();
    document.getElementById('funnelModal').classList.add('open');
  }

  function renderSettingsFunnelList() {
    var el=document.getElementById('settingsFunnelList');
    if(!el) return;
    if(!allFunnels.length) {
      el.innerHTML='<div style="color:var(--muted2);font-size:13px;padding:8px 0">Воронки загружаются... Если список пуст — сохраните настройки и обновите страницу.</div>';
      return;
    }

    var selectedCount = draftFunnelStages.length;
    var totalCount = allFunnels.reduce(function(n,f){return n+f.stages.length;},0);
    var summaryHtml = '<div class="funnel-summary">'+(selectedCount===0
      ? '✅ Все звонки (нет ограничений)'
      : 'Выбрано этапов: <strong>'+selectedCount+'</strong> из '+totalCount)+'</div>';

    var funnelsHtml = allFunnels.map(function(f, fi) {
      var selectedInFunnel = f.stages.filter(function(s){
        return draftFunnelStages.indexOf(f.id+'::'+s.id)!==-1;
      }).length;
      var badge = selectedInFunnel > 0
        ? '<span class="funnel-selected-badge">'+selectedInFunnel+'/'+f.stages.length+'</span>'
        : '';
      var stagesHtml = f.stages.map(function(s){
        var key=f.id+'::'+s.id;
        var checked=draftFunnelStages.indexOf(key)!==-1;
        return '<label class="funnel-stage-row">'+
          '<input type="checkbox" class="settings-funnel-cb" data-key="'+key+'" data-fi="'+fi+'"'+(checked?' checked':'')+'>'+
          '<span class="funnel-stage-name">'+esc(s.name)+'</span>'+
          '</label>';
      }).join('');

      return '<div class="funnel-accordion" data-fi="'+fi+'">'+
        '<div class="funnel-accordion-head" data-fi="'+fi+'">'+
          '<span class="funnel-accordion-arrow">▶</span>'+
          '<span class="funnel-accordion-title">'+esc(f.name)+'</span>'+
          badge+
        '</div>'+
        '<div class="funnel-accordion-body" style="display:none">'+stagesHtml+'</div>'+
      '</div>';
    }).join('');

    el.innerHTML = summaryHtml + funnelsHtml;

    // Аккордеон
    el.querySelectorAll('.funnel-accordion-head').forEach(function(head){
      head.addEventListener('click', function(){
        var body=head.nextElementSibling;
        var arrow=head.querySelector('.funnel-accordion-arrow');
        var open=body.style.display!=='none';
        body.style.display=open?'none':'';
        arrow.textContent=open?'▶':'▼';
        head.classList.toggle('open',!open);
      });
    });

    // Чекбоксы
    el.querySelectorAll('.settings-funnel-cb').forEach(function(cb){
      cb.addEventListener('change', function(){
        var key=cb.dataset.key;
        if(cb.checked){ if(draftFunnelStages.indexOf(key)===-1) draftFunnelStages.push(key); }
        else { draftFunnelStages=draftFunnelStages.filter(function(k){ return k!==key; }); }
        // Обновляем бейдж на заголовке
        var fi=cb.dataset.fi;
        var f=allFunnels[parseInt(fi)];
        if(!f) return;
        var selCount=f.stages.filter(function(s){return draftFunnelStages.indexOf(f.id+'::'+s.id)!==-1;}).length;
        var head=el.querySelector('.funnel-accordion-head[data-fi="'+fi+'"]');
        if(head){
          var old=head.querySelector('.funnel-selected-badge');
          if(old) old.remove();
          if(selCount>0){
            var span=document.createElement('span');
            span.className='funnel-selected-badge';
            span.textContent=selCount+'/'+f.stages.length;
            head.appendChild(span);
          }
        }
        // Обновляем summary
        var sum=el.querySelector('.funnel-summary');
        if(sum){
          var sc=draftFunnelStages.length;
          sum.innerHTML=sc===0?'✅ Все звонки (нет ограничений)':'Выбрано этапов: <strong>'+sc+'</strong> из '+totalCount;
        }
      });
    });

    var totalCount = allFunnels.reduce(function(n,f){return n+f.stages.length;},0); // re-declare for closure
  }

  function renderFunnelList() {
    // Оставляем для совместимости (модал фильтра)
    var el=document.getElementById('funnelFilterList'); if(!el) return;
    el.innerHTML='<div style="color:var(--muted2);font-size:13px;padding:10px 0">Настройте воронки в разделе ⚙️ Настройки.</div>';
  }

  function updateFunnelFilterLabel() {
    // Нет кнопки в filter-bar — просто заглушка для обратной совместимости
  }

  function matchesFunnelFilter(c) {
    if(!activeFilters.funnelStages.length) return true;
    if(!c._crmResolved) return true; // ещё не загружено — показываем
    var key = c._crmResolved.type+'_'+c._crmResolved.id;
    var stageInfo = crmStageCache[key];
    if(!stageInfo) return true; // этап ещё не загружен — показываем
    // Ищем совпадение
    var callFunnelId = null;
    var callStageId = null;
    // Определяем funnelId и stageId из stageInfo
    allFunnels.forEach(function(f){
      f.stages.forEach(function(s){
        if(s.name===stageInfo.stageName && f.name.replace('Сделки: ','')===stageInfo.funnelName) {
          callFunnelId=f.id; callStageId=s.id;
        }
      });
    });
    if(!callFunnelId) return true;
    return activeFilters.funnelStages.indexOf(callFunnelId+'::'+callStageId)!==-1;
  }

  function loadCallsFromBX24() {
    allLoadedCalls=[]; calls=[]; currentPage=0; selectedCallIds=[];
    updateBulkBar();
    var nameMap={}; allManagers.forEach(function(m){ nameMap[m.id]=m.name; });
    var allowed=cfg.allowedUsers&&cfg.allowedUsers.length?cfg.allowedUsers:[];
    var bxFilter={};
    var df=activeFilters.dateFrom||(function(){var d=new Date();d.setDate(d.getDate()-89);d.setHours(0,0,0,0);return d;})();
    var dt=activeFilters.dateTo||(function(){var d=new Date();d.setHours(23,59,59,999);return d;})();
    bxFilter['>=CALL_START_DATE']=toBX24Date(df,false);
    bxFilter['<=CALL_START_DATE']=toBX24Date(dt,true);
    if(activeFilters.hasRecord) bxFilter['!CALL_RECORD_URL']='';
    if(activeFilters.managers.length===1) bxFilter['PORTAL_USER_ID']=activeFilters.managers[0];

    var wUrl=getActiveServerUrl();
    if(!wUrl){alert('Настройте URL сервера в ⚙️ Настройках.');return;}

    var gen=++loadCallsFromBX24._gen;
    var seenIds={}, stored=loadAnalyses();
    hidePagination();
    showLoading('Загрузка: '+bxFilter['>=CALL_START_DATE']+' — '+bxFilter['<=CALL_START_DATE']);

    function fetchPage(start, pageCount) {

      if(loadCallsFromBX24._gen!==gen) return;
      if(pageCount>200){showLoading('');goPage(currentPage);return;}

      var auth = BX24.getAuth();
      xhrPost(wUrl+'/bx24-calls', {
        domain: auth.domain,
        token:  auth.access_token,
        filter: bxFilter,
        order:  {CALL_START_DATE:'DESC'},
        start:  start,
      }, 30000, function(err, res) {
        if(loadCallsFromBX24._gen!==gen) return;
        if(err){
          showLoading('');
          showDiag('Ошибка bx24-calls:\n'+err);
          renderCalls(); return;
        }
        var batch=res.result||[];
        if(!batch.length){showLoading('');goPage(currentPage);return;}
        batch.forEach(function(item) {
          var id=item.CALL_ID||item.ID; if(!id||seenIds[id]) return; seenIds[id]=true;
          var uid=item.PORTAL_USER_ID?String(item.PORTAL_USER_ID):'';
          if(allowed.length && allowed.indexOf(uid)===-1) return;
          if(activeFilters.managers.length>1 && activeFilters.managers.indexOf(uid)===-1) return;
          var c=mapCall(item, nameMap);
          if(cfg.crmEntityTypes.length && !(cfg.crmEntityTypes.includes(c.crm_entity_type === null ? 'null' : c.crm_entity_type))) return;
          if(stored[c.id]) c.analysis=stored[c.id];
          allLoadedCalls.push(c);
        });
        allLoadedCalls.sort(function(a,b){ return b.ts-a.ts; });
        if(res.next != null){
          showLoading('Загружено '+allLoadedCalls.length+'...');
          goPage(currentPage);
          fetchPage(res.next, pageCount+1);
        } else { 
          showLoading('');
          goPage(currentPage); 
        }
      });
    }
    fetchPage(0,0);
  }
  loadCallsFromBX24._gen=0;

  function goPage(n) {
    var maxPage=Math.max(0,Math.ceil(allLoadedCalls.length/PAGE_SIZE)-1);
    currentPage=Math.max(0,Math.min(n,maxPage));
    calls=allLoadedCalls.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);
    renderCalls();
    renderPagination(currentPage,Math.ceil(allLoadedCalls.length/PAGE_SIZE)||1,allLoadedCalls.length);
  }

  function renderPagination(page,totalPages,total) {
    var wrap=document.getElementById('paginationWrap'); if(!wrap) return;
    if(totalPages<=1){wrap.style.display='none';return;}
    var from=page*PAGE_SIZE+1, to=Math.min((page+1)*PAGE_SIZE,total);
    wrap.style.display='flex';
    wrap.innerHTML='<button class="btn btn-ghost sm" id="pgPrev"'+(page>0?'':' disabled')+'>← Назад</button>'+
      '<span class="pg-info">'+from+'–'+to+' из '+total+'</span>'+
      '<button class="btn btn-secondary sm" id="pgNext"'+(page<totalPages-1?'':' disabled')+'>Вперёд →</button>';
    document.getElementById('pgPrev').onclick=function(){goPage(page-1);};
    document.getElementById('pgNext').onclick=function(){goPage(page+1);};
  }
  function hidePagination(){var w=document.getElementById('paginationWrap');if(w){w.style.display='none';w.innerHTML='';}}

  function mapCall(item, nameMap) {
    var uid=item.PORTAL_USER_ID?String(item.PORTAL_USER_ID):'';
    var durRaw=parseInt(item.CALL_DURATION)||0;

    return {
      id:           item.CALL_ID||item.ID,
      ts:           item.CALL_START_DATE?new Date(item.CALL_START_DATE):new Date(0),
      contact:      item.PHONE_NUMBER||item.PORTAL_NUMBER||'Неизвестный',
      phone:        item.PHONE_NUMBER||item.PORTAL_NUMBER||'—',
      userId:       uid,
      manager:      nameMap[uid]||(uid?'Сотрудник #'+uid:'—'),
      callType:     String(item.CALL_TYPE||''),
      duration:     formatDur(item.CALL_DURATION),
      _durationSec: durRaw,
      _recordUrl:   item.CALL_RECORD_URL||null,
      _crmResolved: null,
      analysis:     null,
      crm_entity_type: item.CRM_ENTITY_TYPE,
      crm_entity_id: item.CRM_ENTITY_ID,
      missed: String(item.CALL_TYPE)==='2' && parseInt(item.CALL_FAILED_CODE||0)==304,
    };
  }

  /* ══════════════════════════════════════════════
     MULTI-SELECT / BULK BAR
  ══════════════════════════════════════════════ */
  function bindBulkBar() {
    // "Выбрать все" чекбокс в шапке таблицы
    var selectAll=document.getElementById('selectAllCalls');
    if(selectAll) selectAll.addEventListener('change', function(){
      if(this.checked) {
        var filtered=getFiltered();
        selectedCallIds=filtered.map(function(c){return c.id;});
      } else {
        selectedCallIds=[];
      }
      updateBulkBar(); renderCalls();
      // Восстановить состояние главного чекбокса (renderCalls его перерисовывает)
      var el=document.getElementById('selectAllCalls');
      if(el) el.checked=selectedCallIds.length>0;
    });

    var bulkClear=document.getElementById('bulkClearBtn');
    if(bulkClear) bulkClear.addEventListener('click', function(){
      selectedCallIds=[]; updateBulkBar(); renderCalls();
    });
    var bulkScript=document.getElementById('bulkScriptBtn');
    if(bulkScript) bulkScript.addEventListener('click', openBulkScriptCheck);
    var bulkGroup=document.getElementById('bulkGroupBtn');
    if(bulkGroup) bulkGroup.addEventListener('click', groupSelectedByContact);
  }

  function toggleCallSelect(callId) {
    var idx=selectedCallIds.indexOf(callId);
    if(idx===-1) selectedCallIds.push(callId); else selectedCallIds.splice(idx,1);
    updateBulkBar();
    // Обновить класс строки
    document.querySelectorAll('tr[data-call-id="'+callId+'"]').forEach(function(tr){
      tr.classList.toggle('row-selected', selectedCallIds.indexOf(callId)!==-1);
    });
    // Обновить чекбокс
    document.querySelectorAll('.call-select-cb[data-id="'+callId+'"]').forEach(function(cb){
      cb.checked = selectedCallIds.indexOf(callId)!==-1;
    });
  }

  function updateBulkBar() {
    var bar=document.getElementById('bulkBar'); if(!bar) return;
    var count=selectedCallIds.length;
    bar.classList.toggle('visible', count>0);
    setText('bulkCount', count);
  }

  function groupSelectedByContact() {
    if(!selectedCallIds.length) return;
    // Группируем выбранные по номеру телефона
    var groups={};
    selectedCallIds.forEach(function(id){
      var c=allLoadedCalls.find(function(x){return x.id===id;}); if(!c) return;
      var key=c.phone||'unknown';
      if(!groups[key]) groups[key]={phone:key,calls:[]};
      groups[key].calls.push(c);
    });
    var groupList=Object.values(groups);
    // Показываем сводку
    var msg=groupList.map(function(g){
      return g.phone+': '+g.calls.length+' звонков ('+g.calls.map(function(c){return fmtDate(c.ts);}).join(', ')+')';
    }).join('\n');
    alert('Группировка выбранных звонков:\n\n'+msg+'\n\nВсего контактов: '+groupList.length);
  }

  function openBulkScriptCheck() {
    if(!selectedCallIds.length){alert('Выберите хотя бы один звонок');return;}
    var scripts=loadScripts();
    if(!scripts.length){alert('Добавьте скрипт в разделе «Скрипты»');return;}

    // Проверяем что у выбранных есть транскрипты
    var withTranscript=selectedCallIds.filter(function(id){
      var c=allLoadedCalls.find(function(x){return x.id===id;});
      return c&&c.analysis&&c.analysis.transcript&&c.analysis.transcript.length;
    });
    var withoutTranscript=selectedCallIds.length-withTranscript.length;

    if(!withTranscript.length){
      alert('У выбранных звонков нет расшифровок. Сначала запустите анализ.');return;
    }

    // Открываем модал с выбором скрипта
    showBulkScriptModal(withTranscript, withoutTranscript, scripts);
  }

  function showBulkScriptModal(transcriptIds, skippedCount, scripts) {
    // Используем существующий modalContent через специальный режим
    // Открываем карточку первого звонка в режиме bulk
    var firstId=transcriptIds[0];
    var c=allLoadedCalls.find(function(x){return x.id===firstId;}); if(!c) return;

    // Открываем modal в bulk-режиме
    modalCallId='__bulk__';
    modalActiveTab='scriptcheck';
    modalScriptCheckResult=null;

    setText('modalPhone', transcriptIds.length+' звонков выбрано');
    var crmEl=document.getElementById('modalCrmLink');
    if(crmEl) crmEl.innerHTML='<span style="color:var(--muted2)">Групповая проверка по скрипту</span>';
    var metaEl=document.getElementById('modalMeta');
    if(metaEl) metaEl.innerHTML='<span class="modal-call-meta-chip">📋 '+transcriptIds.length+' звонков · '+
      (skippedCount>0?skippedCount+' пропущено (нет расшифровки)':'все с расшифровкой')+'</span>';
    var audioWrap=document.getElementById('modalAudioWrap');
    if(audioWrap) audioWrap.style.display='none';
    var tabsEl=document.getElementById('modalTabs');
    if(tabsEl) tabsEl.style.display='none';

    document.getElementById('callModal').classList.add('open');

    var scriptBtns=scripts.map(function(s){
      return '<button class="btn btn-secondary sm run-bulk-script-btn" data-sid="'+s.id+'" style="width:100%;justify-content:flex-start;margin-bottom:6px">'+
        '📋 '+esc(s.name)+'</button>';
    }).join('');

    document.getElementById('modalContent').innerHTML=
      '<div style="margin-bottom:12px;padding:10px 12px;background:var(--accent-bg);border:1px solid #bfdbfe;border-radius:8px;font-size:13px;color:var(--accent)">'+
        '🔗 Выбрано звонков: <strong>'+transcriptIds.length+'</strong>. Транскрипты объединятся в один для анализа.'+
      '</div>'+
      '<div class="scriptcheck-select-label" style="margin-bottom:10px">Выберите скрипт:</div>'+
      scriptBtns+
      '<div id="bulkScriptResult"></div>';

    document.getElementById('modalContent').querySelectorAll('.run-bulk-script-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        runBulkScriptCheck(transcriptIds, btn.dataset.sid);
      });
    });
  }

  function runBulkScriptCheck(callIds, scriptId) {
    var scripts=loadScripts();
    var script=scripts.find(function(x){return x.id===scriptId;}); if(!script) return;
    if(!getActiveServerUrl()){alert('Настройте URL сервера в ⚙️ Настройках.');return;}

    var resultArea=document.getElementById('bulkScriptResult');
    if(resultArea) resultArea.innerHTML='<div class="loading-row" style="padding:14px 0"><span class="spinner"></span>&nbsp; Анализирую '+callIds.length+' звонков по скрипту «'+esc(script.name)+'»...</div>';

    // Объединяем транскрипты
    var combinedTranscript='';
    callIds.forEach(function(id, idx){
      var c=allLoadedCalls.find(function(x){return x.id===id;}); if(!c||!c.analysis) return;
      var dateStr=fmtDate(c.ts)+' '+fmtTime(c.ts);
      combinedTranscript+='\n\n=== ЗВОНОК '+(idx+1)+' ('+dateStr+', '+esc(c.manager)+') ===\n';
      combinedTranscript+=c.analysis.transcript.map(function(m){
        return (m.role==='agent'?'МЕНЕДЖЕР: ':'КЛИЕНТ: ')+m.text;
      }).join('\n');
    });

    var allChecks=[];
    script.sections.forEach(function(sec){ sec.items.forEach(function(item){ allChecks.push({section:sec.name,check:item}); }); });
    var checkList=allChecks.map(function(ch,i){return (i+1)+'. ['+ch.section+'] '+ch.check;}).join('\n');

    var payload={
      transcript:'ЗАДАЧА: Проверь объединённую расшифровку нескольких звонков по чек-листу скрипта.\n'+
        'Учитывай ВСЕ звонки как единый диалог с клиентом.\n'+
        'Верни ТОЛЬКО JSON без markdown:\n'+
        '{"score":75,"results":[{"check":"текст","section":"раздел","verdict":"Да","evidence":"цитата или обоснование"}]}\n\n'+
        'ЧЕК-ЛИСТ:\n'+checkList+'\n\nРАСШИФРОВКА (несколько звонков):\n'+combinedTranscript.slice(0,4000),
      model: cfg.dsModel||'deepseek-chat'
    };

    xhrPost(getActiveServerUrl()+'/analyze-text', payload, 300000, function(err, result){
      if(err){
        if(resultArea) resultArea.innerHTML='<div style="color:var(--red);padding:14px 0">Ошибка: '+esc(err)+'</div>';
        return;
      }
      var parsed=parseScriptCheckResult(result, allChecks, script);
      modalScriptCheckResult={script, data:parsed, isBulk:true, callIds};

      // Обновляем score для каждого выбранного звонка
      callIds.forEach(function(id){
        var c=allLoadedCalls.find(function(x){return x.id===id;}); if(!c||!c.analysis) return;
        c.analysis._score=parsed.score;
        c.analysis._scoreFromScript=true;
        saveAnalysis(id, c.analysis);
        updateAnalyzedRow(id);
      });

      if(resultArea) resultArea.innerHTML=renderScriptCheckResultHtml(modalScriptCheckResult)+
        '<div style="margin-top:10px;font-size:12px;color:var(--green)">✅ Оценка обновлена для '+callIds.length+' звонков</div>';
    });
  }

  /* ══════════════════════════════════════════════
     FILTERS
  ══════════════════════════════════════════════ */
  function bindFilters() {
    document.getElementById('staffFilterBtn').addEventListener('click', openStaffModal);
    document.getElementById('dateFilterBtn').addEventListener('click', openDateModal);
    document.getElementById('applyFiltersBtn').addEventListener('click', function() {
      activeFilters.hasRecord=document.getElementById('filterHasRecord').checked;
      activeFilters.sentiment=document.getElementById('filterSentiment').value;
      renderCalls();
    });
    document.getElementById('resetFiltersBtn').addEventListener('click', function() {
      calcPreset('7days', draftDate);
      // Сохраняем minDuration и funnelStages из настроек — они не сбрасываются кнопкой «Сбросить» фильтров
      activeFilters={
        dateFrom:draftDate.from, dateTo:draftDate.to,
        dateLabel:'Последние 7 дней', datePreset:'7days',
        managers:[], hasRecord:true, sentiment:'',
        minDuration: activeFilters.minDuration,
        funnelStages: activeFilters.funnelStages
      };
      draftManagers=[];
      setText('dateFilterLabel','Последние 7 дней');
      setText('staffFilterLabel','Все сотрудники');
      document.getElementById('filterHasRecord').checked=true;
      document.getElementById('filterSentiment').value='';
      document.getElementById('dateFilterBtn').classList.remove('active-filter');
      document.getElementById('staffFilterBtn').classList.remove('active-filter');
      document.querySelectorAll('.preset-btn').forEach(function(b){ b.classList.toggle('active',b.dataset.preset==='7days'); });
      loadCallsFromBX24();
    });
  }

  function getFiltered() {
    var minSec = activeFilters.minDuration != null ? activeFilters.minDuration : 10;
    return calls.filter(function(c) {
      if(activeFilters.hasRecord && !c._recordUrl) return false;
      if(activeFilters.managers.length>0 && activeFilters.managers.indexOf(c.userId)===-1) return false;
      if(activeFilters.sentiment==='none' && c.analysis) return false;
      if(activeFilters.sentiment && activeFilters.sentiment!=='none') {
        if(!c.analysis||c.analysis.sentiment!==activeFilters.sentiment) return false;
      }
      // Фильтр по длительности
      if(minSec > 0 && c._durationSec < minSec) return false;
      // Фильтр по воронке/этапу
      if(!matchesFunnelFilter(c)) return false;
      return true;
    });
  }

  /* ──── DATE MODAL ──── */
  function calcPreset(preset, target) {
    var now=new Date(), from, to=new Date(now); to.setHours(23,59,59,999);
    if(preset==='today')         {from=new Date(now);from.setHours(0,0,0,0);}
    else if(preset==='yesterday'){from=new Date(now);from.setDate(from.getDate()-1);from.setHours(0,0,0,0);to=new Date(from);to.setHours(23,59,59,999);}
    else if(preset==='7days')    {from=new Date(now);from.setDate(from.getDate()-6);from.setHours(0,0,0,0);}
    else if(preset==='30days')   {from=new Date(now);from.setDate(from.getDate()-29);from.setHours(0,0,0,0);}
    else if(preset==='month')    {from=new Date(now.getFullYear(),now.getMonth(),1);}
    else{from=null;to=null;}
    target.from=from; target.to=to; target.preset=preset;
  }

  function openDateModal() {
    draftDate.from=activeFilters.dateFrom; draftDate.to=activeFilters.dateTo; draftDate.preset=activeFilters.datePreset;
    var dfEl=document.getElementById('dateFrom'), dtEl=document.getElementById('dateTo');
    if(dfEl) dfEl.value=draftDate.from?toInputDate(draftDate.from):'';
    if(dtEl) dtEl.value=draftDate.to?toInputDate(draftDate.to):'';
    document.querySelectorAll('.preset-btn').forEach(function(b){b.classList.toggle('active',b.dataset.preset===draftDate.preset);});
    document.getElementById('dateModal').classList.add('open');
  }
  function closeDateModal(){document.getElementById('dateModal').classList.remove('open');}
  function applyDateFilter(){
    var mf=document.getElementById('dateFrom'), mt=document.getElementById('dateTo');
    if(mf&&mf.value) draftDate.from=new Date(mf.value+'T00:00:00');
    if(mt&&mt.value) draftDate.to=new Date(mt.value+'T23:59:59');
    activeFilters.dateFrom=draftDate.from; activeFilters.dateTo=draftDate.to; activeFilters.datePreset=draftDate.preset||'custom';
    var LABELS={today:'Сегодня',yesterday:'Вчера','7days':'Последние 7 дней','30days':'Последние 30 дней',month:'Этот месяц',all:'Всё время'};
    var label=LABELS[activeFilters.datePreset]||((mf&&mf.value||'…')+' — '+(mt&&mt.value||'…'));
    activeFilters.dateLabel=label; setText('dateFilterLabel',label);
    document.getElementById('dateFilterBtn').classList.toggle('active-filter',activeFilters.datePreset!=='all');
    closeDateModal(); loadCallsFromBX24();
  }

  /* ──── STAFF FILTER — только allowedUsers из настроек ──── */
  function getFilterableManagers() {
    // п.8: в фильтре показываем только разрешённых сотрудников
    if(!cfg.allowedUsers || !cfg.allowedUsers.length) return allManagers;
    return allManagers.filter(function(m){ return cfg.allowedUsers.indexOf(m.id)!==-1; });
  }

  function openStaffModal() {
    draftManagers=activeFilters.managers.slice();
    document.getElementById('staffSearch').value='';
    renderStaffList('');
    document.getElementById('staffModal').classList.add('open');
  }
  function closeStaffModal(){document.getElementById('staffModal').classList.remove('open');}
  function applyStaffFilter(){
    activeFilters.managers=draftManagers.slice();
    var count=activeFilters.managers.length;
    var availManagers=getFilterableManagers();
    var label=count===0?'Все сотрудники':count===1?(availManagers.find(function(m){return m.id===activeFilters.managers[0];})||{name:'1 сотрудник'}).name:count+' сотрудника(ов)';
    setText('staffFilterLabel',label);
    document.getElementById('staffFilterBtn').classList.toggle('active-filter',count>0);
    closeStaffModal(); loadCallsFromBX24();
  }
  function renderStaffList(query) {
    var list=document.getElementById('staffList'); if(!list) return;
    var available=getFilterableManagers();
    var filtered=query?available.filter(function(m){return m.name.toLowerCase().indexOf(query)!==-1;}):available;
    if(!filtered.length){list.innerHTML='<div class="empty-hint" style="padding:16px">Нет сотрудников</div>';return;}
    list.innerHTML=filtered.map(function(m){
      var sel=draftManagers.indexOf(m.id)!==-1;
      return '<div class="staff-item'+(sel?' selected':'')+'" data-id="'+m.id+'">'+
        '<div class="staff-avatar">'+(m.name.charAt(0)||'?')+'</div>'+
        '<div class="staff-name">'+esc(m.name)+'</div>'+
        '<input type="checkbox" class="staff-check"'+(sel?' checked':'')+' tabindex="-1">'+
      '</div>';
    }).join('');
    list.querySelectorAll('.staff-item').forEach(function(item){
      item.addEventListener('click',function(){
        var id=item.dataset.id, idx=draftManagers.indexOf(id);
        if(idx===-1) draftManagers.push(id); else draftManagers.splice(idx,1);
        renderStaffList(query);
      });
    });
  }

  /* ══════════════════════════════════════════════
     BIND MODALS
  ══════════════════════════════════════════════ */
  function bindModals() {
    document.getElementById('dateModalClose').addEventListener('click',closeDateModal);
    document.getElementById('dateModalClose2').addEventListener('click',closeDateModal);
    document.getElementById('dateModal').addEventListener('click',function(e){if(e.target===e.currentTarget)closeDateModal();});
    document.querySelectorAll('.preset-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        document.querySelectorAll('.preset-btn').forEach(function(b){b.classList.remove('active');});
        btn.classList.add('active'); calcPreset(btn.dataset.preset,draftDate);
        var dfEl=document.getElementById('dateFrom'), dtEl=document.getElementById('dateTo');
        if(dfEl) dfEl.value=draftDate.from?toInputDate(draftDate.from):'';
        if(dtEl) dtEl.value=draftDate.to?toInputDate(draftDate.to):'';
      });
    });
    ['dateFrom','dateTo'].forEach(function(id){
      var el=document.getElementById(id);
      if(el) el.addEventListener('change',function(){document.querySelectorAll('.preset-btn').forEach(function(b){b.classList.remove('active');});draftDate.preset='custom';});
    });
    document.getElementById('dateApplyBtn').addEventListener('click',applyDateFilter);
    document.getElementById('staffModalClose').addEventListener('click',closeStaffModal);
    document.getElementById('staffModal').addEventListener('click',function(e){if(e.target===e.currentTarget)closeStaffModal();});
    document.getElementById('staffSearch').addEventListener('input',function(){renderStaffList(this.value.toLowerCase());});
    document.getElementById('staffSelectAll').addEventListener('click',function(){draftManagers=getFilterableManagers().map(function(m){return m.id;});renderStaffList('');});
    document.getElementById('staffClearAll').addEventListener('click',function(){draftManagers=[];renderStaffList('');});
    document.getElementById('staffApplyBtn').addEventListener('click',applyStaffFilter);
    document.getElementById('modalClose').addEventListener('click',closeModal);
    document.getElementById('callModal').addEventListener('click',function(e){if(e.target===e.currentTarget)closeModal();});
    document.getElementById('modalTabs').addEventListener('click',function(e){
      var tab=e.target.closest('.modal-tab'); if(!tab) return;
      var t=tab.dataset.tab;
      document.querySelectorAll('.modal-tab').forEach(function(b){b.classList.toggle('active',b.dataset.tab===t);});
      renderModalTab(t);
    });
    document.querySelectorAll('.toggle-switch').forEach(function(btn){
      btn.addEventListener('click',function(){btn.classList.toggle('on');});
    });
    document.getElementById('scriptAddClose').addEventListener('click',closeScriptAddModal);
    document.getElementById('scriptAddModal').addEventListener('click',function(e){if(e.target===e.currentTarget)closeScriptAddModal();});
    document.getElementById('scriptAddCancelBtn').addEventListener('click',closeScriptAddModal);
    document.getElementById('scriptAddSaveBtn').addEventListener('click',saveNewScript);
  }

  /* ══════════════════════════════════════════════
     RENDER CALLS TABLE
  ══════════════════════════════════════════════ */
  function showLoading(msg){
    var el=document.getElementById('callsLoading'); if(!el) return;
    if(!msg){el.style.display='none';return;}
    el.style.display=''; el.innerHTML='<span class="spinner"></span>&nbsp; '+msg;
  }
  function showDiag(msg){
    var el=document.getElementById('callsEmpty'); if(!el) return;
    el.style.display='';
    el.innerHTML='<div class="empty-icon">⚠️</div><div style="font-weight:600;margin-bottom:8px">Звонки не загружены</div>'+
      '<div style="font-size:12px;white-space:pre-line;text-align:left;max-width:480px;background:var(--surface2);padding:12px;border-radius:8px;font-family:var(--mono)">'+esc(msg)+'</div>';
    var t=document.getElementById('callsTable'); if(t) t.style.display='none';
  }

  function renderCalls() {
    var filtered=getFiltered();
    // Сортировка от новых к старым (на случай если был сброс)
    filtered.sort(function(a,b){return b.ts-a.ts;});

    var allWithRec=allLoadedCalls.filter(function(c){return !!c._recordUrl;}).length;
    var analyzed=allLoadedCalls.filter(function(c){return !!c.analysis;});
    var neg=analyzed.filter(function(c){return c.analysis.sentiment==='negative';}).length;
    var missed=allLoadedCalls.filter(function(c){return !!c.missed;}).length;
    setText('statTotal',allLoadedCalls.length);
    setText('statRecord',allWithRec);
    setText('statDone',analyzed.length);
    setText('statNeg',neg+missed);
    setText('statPeriodLabel',activeFilters.dateLabel||'');
    var cnt=document.getElementById('filtersCount');
    if(cnt) cnt.innerHTML='Показано: <strong>'+filtered.length+'</strong> из '+calls.length;
    setText('callsBadge',filtered.length||'');

    var loading=document.getElementById('callsLoading');
    var empty=document.getElementById('callsEmpty');
    var table=document.getElementById('callsTable');
    var tbody=document.getElementById('callsBody');
    if(!tbody) return;
    if(loading) loading.style.display='none';
    if(!filtered.length){
      if(table) table.style.display='none';
      if(empty){empty.style.display='';empty.innerHTML='<div class="empty-icon">🔍</div><div>Нет звонков по выбранным фильтрам</div>';}
    } else {
      if(empty) empty.style.display='none';
      if(table) table.style.display='';
      tbody.innerHTML=filtered.map(callRow).join('');
      bindCallActions(tbody);
    }
  }

  function callRow(c) {
    var a=c.analysis;
    var score=a?calcScore(a):null;
    var isSelected=selectedCallIds.indexOf(c.id)!==-1;

    // Чекбокс мультивыбора
    var cbCell='<td style="width:28px;padding:9px 4px 9px 10px">'+
      '<input type="checkbox" class="call-select-cb" data-id="'+c.id+'"'+(isSelected?' checked':'')+'>'+
    '</td>';

    var dateCell='<td style="white-space:nowrap;font-size:12px">'+
      '<div style="font-weight:600;color:var(--text)">'+fmtDate(c.ts)+'</div>'+
      '<div style="color:var(--muted2);margin-top:1px">'+fmtTime(c.ts)+'</div></td>';

    // Контакт: просто номер (не кликабельный), ниже — CRM-ссылка с именем
    var crmHtml='';
    if(c._crmResolved) {
      // Только имя контакта/лида/компании, кликабельно — без типа-бейджа
      crmHtml='<div class="crm-chip" data-crm-type="'+c._crmResolved.type+'" data-crm-id="'+c._crmResolved.id+'" data-call-id="'+c.id+'" style="margin-top:3px">'+
        esc(c._crmResolved.name)+'</div>';
    } else {
      // Lazy load
      crmHtml='<div class="crm-chip crm-lazy" data-phone="'+esc(c.phone)+'" data-call-id="'+c.id+'" style="color:var(--muted);margin-top:3px">⏳</div>';
    }

    var tagsHtml=(a&&a.topics&&a.topics.length)?
      '<div class="row-tags" data-id="'+c.id+'">'+topicsHtml(a.topics)+'</div>':
      '<div class="row-tags" data-id="'+c.id+'"></div>';

    // Номер телефона — просто текст, не ссылка (CRM-чип внизу сам ведёт на карточку)
    var contactCell='<td>'+
      '<div style="font-size:13px;font-weight:600;color:var(--text)">'+esc(c.contact)+'</div>'+
      crmHtml+tagsHtml+'</td>';

    var mgrCell='<td style="font-size:12px;color:var(--text2)">'+esc(c.manager)+'</td>';

    // Воронка / этап — lazy load через lookupCrmStage
    var stageInfo = c._crmResolved ? crmStageCache[c._crmResolved.type+'_'+c._crmResolved.id] : undefined;
    var funnelCellInner;
    if(!c._crmResolved) {
      // CRM ещё не загружен — ждём
      funnelCellInner='<span class="funnel-stage-lazy" data-call-id="'+c.id+'" style="color:var(--muted);font-size:11px">—</span>';
    } else if(stageInfo===undefined) {
      // CRM загружен, этап ещё нет
      funnelCellInner='<span class="funnel-stage-lazy" data-call-id="'+c.id+'" style="color:var(--muted);font-size:11px">⏳</span>';
    } else if(stageInfo) {
      funnelCellInner=funnelStageHtml(stageInfo, {id:c.crm_entity_id, type:c.crm_entity_type});
    } else {
      funnelCellInner='<span style="color:var(--muted2);font-size:11px">—</span>';
    }
    var funnelCell='<td class="funnel-cell" data-id="'+c.id+'">'+funnelCellInner+'</td>';

    // BX24 CALL_TYPE: 1=Исходящий, 2=Входящий, 3=Входящий (на линию), 4=Обратный звонок
    var typeLabel=c.callType==='1'?'Исходящий':c.callType==='2'?'Входящий':c.callType==='3'?'Входящий':c.callType==='4'?'Обратный':'—';
    var typeCls=c.callType==='1'?'call-type-out':c.callType==='2'||c.callType==='3'?'call-type-in':c.callType==='4'?'call-type-in':'call-type-other';
    var typeCell='<td><span class="call-type-badge '+typeCls+'">'+typeLabel+'</span>'+(c.missed?'<span title="Пропущенный" style="margin-left:4px">📵</span>':'')+'</td>';
    var durCell='<td style="font-family:var(--mono);font-size:12px;color:var(--text2)">'+c.duration+'</td>';
    var recCell='<td style="text-align:center">'+(c._recordUrl?'<button class="btn-play play-btn" data-id="'+c.id+'">▶</button>':'<span style="color:var(--muted);font-size:12px">—</span>')+'</td>';

    var scoreHtml=score!=null?scoreBadge(score, a&&a._scoreFromScript, c.id):'<span style="font-size:11px;color:var(--muted)">—</span>';
    var scoreCell='<td class="sent-cell" data-id="'+c.id+'" style="text-align:center">'+scoreHtml+'</td>';
    var auditCell='<td class="audit-cell" data-id="'+c.id+'" style="text-align:right">'+auditBtnHtml(c)+'</td>';

    return '<tr data-call-id="'+c.id+'"'+(isSelected?' class="row-selected"':'')+'>'+
      cbCell+dateCell+contactCell+funnelCell+mgrCell+typeCell+durCell+recCell+scoreCell+auditCell+'</tr>';
  }

  function funnelStageHtml(stageInfo, crm) {
    if(!stageInfo) return '<span style="color:var(--muted2);font-size:11px">—</span>';
    var titleText = esc(stageInfo.funnelName) + ' / ' + esc(stageInfo.stageName);
    var inner = '<div title="'+titleText+'" style="font-size:11px;font-weight:600;color:var(--text2)">'+esc(stageInfo.funnelName)+'</div>'+
      '<div title="'+titleText+'" class="funnel-stage-badge">'+esc(stageInfo.stageName)+'</div>';
    if(crm && crm.id && crm.type) {
      var paths = { CONTACT:'crm/contact/details/', LEAD:'crm/lead/details/', COMPANY:'crm/company/details/', DEAL:'crm/deal/details/' };
      var path = paths[crm.type];
      if(path) {
        var domain = BX24.getDomain ? BX24.getDomain() : window.location.hostname;
        return '<a href="https://'+domain+'/'+path+crm.id+'/" target="_blank" style="text-decoration:none">'+inner+'</a>';
      }
    }
    return inner;
  }

  function calcScore(a) {
    if(!a) return null;
    if(a._score!=null) return a._score;
    if(a.pos!=null) {
      if(a.sentiment==='positive') return Math.max(60,a.pos);
      if(a.sentiment==='negative') return Math.min(40,100-a.neg);
      return 50;
    }
    return null;
  }

  function scoreBadge(score, fromScript, callId) {
    var cls = score>=80 ? 'score-high' : score>=50 ? 'score-mid' : 'score-low';
    var clickAttr = fromScript&&callId ? ' role="button" style="cursor:pointer" data-score-open="'+callId+'"' : '';
    return '<span class="score-badge '+cls+'"'+clickAttr+'>'+score+
      (fromScript?'<span class="score-updated" title="Оценка по скрипту — нажмите для просмотра">📋</span>':'')+
    '</span>';
  }

  function auditBtnHtml(c) {
    if(!c._recordUrl) return '<button class="btn btn-ghost sm" disabled style="opacity:.35">—</button>';
    var scripts=loadScripts();
    var job=bgScriptJobs[c.id];
    var scriptBtnHtml='';
    if(scripts.length) {
      if(job && job.status==='running') {
        scriptBtnHtml='<button class="btn btn-script-muted sm" data-id="'+c.id+'" style="margin-right:4px" disabled>⏳</button>';
      } else {
        // Приглушённая иконка скрипта (не яркая)
        scriptBtnHtml='<button class="btn btn-script-muted sm check-script-btn" data-id="'+c.id+'" style="margin-right:4px" title="Проверить по скрипту">📋</button>';
      }
    }
    if(c.analysis) return scriptBtnHtml+'<button class="btn btn-audit sm analyze-btn" data-id="'+c.id+'">✓ Аудит</button>';
    return scriptBtnHtml+'<button class="btn btn-analyze sm analyze-btn" data-id="'+c.id+'">🧠 Анализ</button>';
  }

  function bindCallActions(container) {
    // Чекбоксы мультивыбора
    container.querySelectorAll('.call-select-cb').forEach(function(cb){
      cb.addEventListener('change',function(e){
        e.stopPropagation();
        toggleCallSelect(cb.dataset.id);
      });
    });

    container.querySelectorAll('.analyze-btn').forEach(function(btn){
      btn.addEventListener('click',function(e){
        e.stopPropagation();
        var c=allLoadedCalls.find(function(x){return x.id===btn.dataset.id;});
        if(c&&c.analysis) openCallModal(btn.dataset.id,'overview');
        else analyzeCall(btn.dataset.id);
      });
    });
    container.querySelectorAll('.play-btn').forEach(function(btn){
      btn.addEventListener('click',function(e){e.stopPropagation();openCallModal(btn.dataset.id,'overview');});
    });

    // 📋 — открывает мини-модал выбора скрипта, запускает фоново
    container.querySelectorAll('.check-script-btn').forEach(function(btn){
      btn.addEventListener('click',function(e){
        e.stopPropagation();
        openBgScriptSelectModal(btn.dataset.id);
      });
    });

    // Клик по оценке-бейджу — открыть результат скрипт-чека
    container.querySelectorAll('[data-score-open]').forEach(function(el){
      el.addEventListener('click', function(e){
        e.stopPropagation();
        var callId=el.dataset.scoreOpen;
        var c=allLoadedCalls.find(function(x){return x.id===callId;});
        if(!c) return;
        // Восстанавливаем результат из сохранённых данных
        var saved=c.analysis&&c.analysis.scriptChecks&&Object.values(c.analysis.scriptChecks)[0];
        if(saved) { modalScriptCheckResult=saved; }
        else if(bgScriptJobs[callId]&&bgScriptJobs[callId].checkResult) {
          modalScriptCheckResult=bgScriptJobs[callId].checkResult;
        }
        openCallModal(callId, 'scriptcheck');
      });
    });

    // Lazy load CRM chips
    container.querySelectorAll('.crm-lazy').forEach(function(el){
      var phone=el.dataset.phone;
      var callId=el.dataset.callId;
      var c=allLoadedCalls.find(function(x){return x.id===callId;});

      lookupCrmStage({id:c.crm_entity_id,type:c.crm_entity_type}, function(stageInfo){
        refreshFunnelCell(callId, stageInfo);
      });

      lookupCrm(phone, function(crm){
        if(c) c._crmResolved=crm;
        refreshCrmChip(callId, crm);
      });
    });

    // Lazy load этапов для уже известных CRM
    container.querySelectorAll('.funnel-stage-lazy').forEach(function(el){
      var callId=el.dataset.callId;
      var c=allLoadedCalls.find(function(x){return x.id===callId;});
      if(!c||!c._crmResolved) return;
      var key=c._crmResolved.type+'_'+c._crmResolved.id;
      if(crmStageCache[key]!==undefined) {
        refreshFunnelCell(callId, crmStageCache[key]); return;
      }
      lookupCrmStage({id:c.crm_entity_id,type:c.crm_entity_type}, function(stageInfo){
        refreshFunnelCell(callId, stageInfo);
      });
    });

    // Клик по CRM chip
    container.querySelectorAll('.crm-chip:not(.crm-lazy)').forEach(function(chip){
      chip.addEventListener('click',function(e){
        e.stopPropagation();
        var crm={type:chip.dataset.crmType, id:chip.dataset.crmId};
        openCrmCard(crm);
      });
    });
  }

  function refreshCrmChip(callId, crm) {
    document.querySelectorAll('.crm-chip[data-call-id="'+callId+'"],.crm-lazy[data-call-id="'+callId+'"]').forEach(function(chip){
      if(crm) {
        chip.className='crm-chip';
        chip.dataset.crmType=crm.type;
        chip.dataset.crmId=crm.id;
        chip.style.color='';
        chip.style.marginTop='3px';
        chip.textContent=crm.name;  // только имя, без типа
        chip.onclick=function(e){e.stopPropagation();openCrmCard(crm);};
      } else {
        chip.style.display='none';
      }
    });
  }

  function refreshFunnelCell(callId, stageInfo) {
    var c = allLoadedCalls.find(function(x){ return x.id===callId; });
    var crm = c ? {id:c.crm_entity_id, type:c.crm_entity_type} : null;
    document.querySelectorAll('.funnel-cell[data-id="'+callId+'"]').forEach(function(td){
      td.innerHTML = funnelStageHtml(stageInfo, crm);
    });
  }

  function topicsHtml(topics) {
    if(!topics||!topics.length) return '';
    return topics.slice(0,3).map(function(t){return '<span class="topic-chip">'+esc(t)+'</span>';}).join('')+
      (topics.length>3?'<span class="topic-chip" style="color:var(--muted)">+'+(topics.length-3)+'</span>':'');
  }

  function updateAnalyzedRow(callId) {
    var c=allLoadedCalls.find(function(x){return x.id===callId;}); if(!c||!c.analysis) return;
    var score=calcScore(c.analysis);
    document.querySelectorAll('.audit-cell[data-id="'+callId+'"]').forEach(function(td){
      td.innerHTML=auditBtnHtml(c);
      td.querySelectorAll('.analyze-btn').forEach(function(btn){btn.addEventListener('click',function(e){e.stopPropagation();openCallModal(callId,'overview');});});
      td.querySelectorAll('.check-script-btn').forEach(function(btn){btn.addEventListener('click',function(e){e.stopPropagation();openBgScriptSelectModal(callId);});});
    });
    document.querySelectorAll('.sent-cell[data-id="'+callId+'"]').forEach(function(td){
      td.innerHTML=score!=null?scoreBadge(score, c.analysis._scoreFromScript, callId):'—';
      td.querySelectorAll('[data-score-open]').forEach(function(el){
        el.addEventListener('click',function(e){
          e.stopPropagation();
          var saved=c.analysis.scriptChecks&&Object.values(c.analysis.scriptChecks)[0];
          if(saved) modalScriptCheckResult=saved;
          openCallModal(callId,'scriptcheck');
        });
      });
    });
    document.querySelectorAll('.row-tags[data-id="'+callId+'"]').forEach(function(div){
      div.innerHTML=(c.analysis.topics&&c.analysis.topics.length)?topicsHtml(c.analysis.topics):'';
    });
    setText('statDone',allLoadedCalls.filter(function(c){return !!c.analysis;}).length);
  }

  /* ══════════════════════════════════════════════
     ANALYZE CALL
  ══════════════════════════════════════════════ */
  function analyzeCall(callId) {
    var c=allLoadedCalls.find(function(x){return x.id===callId;}); if(!c) return;
    if(c.analysis){openCallModal(callId,'overview');return;}
    if(!c._recordUrl){alert('У этого звонка нет записи.');return;}
    if(!getActiveServerUrl()){alert('Настройте URL сервера в ⚙️ Настройках.');return;}
    var wUrl=getActiveServerUrl();
    setAuditLoading(callId,'🎙️ Whisper...');
    _sendUrl(c, wUrl, c._recordUrl, callId, function(urlFailed){
      if(!urlFailed) return;
      setAuditLoading(callId,'⬇️ Загрузка...');
      _downloadAudio(c._recordUrl, function(err, b64){
        if(err){setAuditNormal(callId);alert('Не удалось загрузить запись: '+err);return;}
        _sendBase64(c, wUrl, b64, callId);
      });
    });
  }

  function _downloadAudio(url, cb) {
    var xhr=new XMLHttpRequest(); xhr.open('GET',url,true); xhr.responseType='arraybuffer'; xhr.timeout=30000;
    xhr.onload=function(){
      if(xhr.status!==200){cb('HTTP '+xhr.status,null);return;}
      var ct=xhr.getResponseHeader('content-type')||'';
      if(ct.indexOf('html')!==-1||ct.indexOf('json')!==-1){cb('Не аудио: '+ct,null);return;}
      var bytes=new Uint8Array(xhr.response),binary='',CHUNK=8192;
      for(var i=0;i<bytes.length;i+=CHUNK) binary+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+CHUNK,bytes.length)));
      cb(null,btoa(binary));
    };
    xhr.onerror=function(){cb('CORS / сетевая ошибка',null);};
    xhr.ontimeout=function(){cb('Таймаут 30 сек',null);};
    xhr.send();
  }

  function _sendUrl(c, wUrl, audioUrl, callId, onDone) {
    xhrPost(wUrl+'/transcribe',{audio_url:audioUrl,language:cfg.whisperLang||'ru'},90000,function(err,result){
      if(err){if(onDone)onDone(true);return;}
      var tr=(result.text||'').trim(); if(!tr){if(onDone)onDone(true);return;}
      var segments=result.diarized.segments; if(!segments){if(onDone)onDone(true);return;}
      setAuditLoading(callId,'🧠 DeepSeek...');
      xhrPost(wUrl+'/analyze-text',buildAnalyzePayload(c,tr,segments),300000,function(err2,result2){
        setAuditNormal(callId);
        if(err2){alert('DeepSeek: '+err2);if(onDone)onDone(false);return;}
        finishAnalysis(c,result2,tr);
        if(onDone) onDone(false);
      });
    });
  }

  function _sendBase64(c, wUrl, b64, callId) {
    setAuditLoading(callId,'🎙️ Whisper...');
    xhrPost(wUrl+'/transcribe',{audio_base64:b64,language:cfg.whisperLang||'ru'},300000,function(err,result){
      if(err){setAuditNormal(callId);alert('Whisper: '+err);return;}
      var tr=(result.text||'').trim(); if(!tr){setAuditNormal(callId);alert('Пустой транскрипт');return;}
      var segments=result.diarized.segments;
      setAuditLoading(callId,'🧠 DeepSeek...');
      xhrPost(getActiveServerUrl()+'/analyze-text',buildAnalyzePayload(c,tr,segments),300000,function(err2,result2){
        setAuditNormal(callId);
        if(err2){alert('DeepSeek: '+err2);return;}
        finishAnalysis(c,result2,tr);
      });
    });
  }

  /* ПРОМПТ — только русский, резюме обязательно */
  function buildAnalyzePayload(c, transcript, segments) {
    return {
      transcript: transcript,
      segments: segments ? segments : null,
      model: cfg.dsModel||'deepseek-chat',
      manager: c.manager||'',
      contact: c.contact||'',
      system_note: 'ОБЯЗАТЕЛЬНОЕ ПРАВИЛО: все поля ответа (темы, теги, смарт-теги, topics, ключевые моменты, резюме, задачи, разделы) должны быть СТРОГО на русском языке. Запрещено использовать английские слова в темах и тегах. Если тема — английское слово (sales, call, lead и т.п.) — переведи его на русский. Поле resume (резюме) обязательно заполни кратким описанием звонка на русском языке (2-3 предложения).'
    };
  }

  function finishAnalysis(c, result, rawTranscript) {
    c.analysis = normalizeAnalysis(result, c, rawTranscript);
    saveAnalysis(c.id, c.analysis);
    updateAnalyzedRow(c.id);
    // telephony.externalcall.finish — только если есть CALL_ID формата voximplant
    // и настройка включена; 400 = звонок уже закрыт — молча игнорируем
    if(cfg.tgSaveBx==='1') {
      try {
        BX24.callMethod('telephony.externalcall.finish',
          {CALL_ID:c.id, COMMENT:buildComment(c.analysis)},
          function(res){ /* 400 игнорируем */ });
      } catch(e){}
    }
    openCallModal(c.id,'overview');
  }

  function xhrPost(url, payload, timeout, cb) {
    var xhr=new XMLHttpRequest();
    xhr.open('POST',url,true);
    var headers=getServerHeaders();
    Object.keys(headers).forEach(function(k){ xhr.setRequestHeader(k, headers[k]); });
    xhr.timeout=timeout||60000;
    xhr.onload=function(){
      var r; try{r=JSON.parse(xhr.responseText);}catch(e){cb('Невалидный JSON (HTTP '+xhr.status+')',null);return;}
      if(xhr.status!==200||r.error){cb(r.error||'HTTP '+xhr.status,null);return;}
      cb(null,r);
    };
    xhr.onerror=function(){cb('Сетевая ошибка',null);};
    xhr.ontimeout=function(){cb('Таймаут '+Math.round(timeout/1000)+' сек',null);};
    xhr.send(JSON.stringify(payload));
  }

  function setAuditLoading(callId,label){
    document.querySelectorAll('.audit-cell[data-id="'+callId+'"] .analyze-btn').forEach(function(btn){
      btn.disabled=true;
      btn.innerHTML='<span class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px"></span>'+(label||'...');
      btn.className='btn btn-ghost sm analyze-btn';
    });
  }
  function setAuditNormal(callId){
    var c=allLoadedCalls.find(function(x){return x.id===callId;});
    document.querySelectorAll('.audit-cell[data-id="'+callId+'"]').forEach(function(td){
      td.innerHTML=auditBtnHtml(c||{_recordUrl:null});
      td.querySelectorAll('.analyze-btn').forEach(function(btn){btn.addEventListener('click',function(e){e.stopPropagation();analyzeCall(callId);});});
    });
  }

  function normalizeAnalysis(r, c, rawTranscript) {
    if(r.sentiment && r._score!=null) return r;
    if(r.sentiment) { r._score=r.score||calcScoreFromSentiment(r); return r; }
    var score=r.overall_score||r.score||0;
    var sentiment=score>=65?'positive':score>=40?'neutral':'negative';
    var pos=Math.max(0,Math.min(100,score>=65?score:score>=40?Math.round(score*.6):Math.round(score*.3)));
    var neg=Math.max(0,Math.min(100,score<40?100-score:score>=65?Math.round((100-score)*.3):Math.round((100-score)*.4)));
    var neu=Math.max(0,100-pos-neg);
    var topics=(r.sections||[]).map(function(s){return s.name;}).slice(0,5);
    var resume=r.call_summary||r.resume||r.summary||'';
    var keyPoints=[];
    if(resume) keyPoints.push({icon:'📋',label:'Итог',text:resume.slice(0,150)});
    (r.recommendations||[]).slice(0,3).forEach(function(rec){ keyPoints.push({icon:rec.priority==='высокий'?'🚨':rec.priority==='средний'?'⚠️':'💡',label:rec.title,text:rec.description}); });
    var transcript=[];
    var trSrc=rawTranscript||r.transcript_text||'';
    if(typeof trSrc==='string'&&trSrc.trim()) {
      trSrc.split('\n').filter(function(l){return l.trim();}).forEach(function(line,idx){
        var isM=/^(МЕНЕДЖЕР|АГЕНТ|М:|А:)/i.test(line.trim());
        var text=line.replace(/^(МЕНЕДЖЕР|АГЕНТ|КЛИЕНТ|М:|К:|А:)\s*/i,'').trim();
        if(text) transcript.push({role:isM?'agent':'client',name:isM?(c.manager||'Менеджер'):'Клиент',time:Math.floor(idx*.5)+':'+(idx%2===0?'00':'30'),text});
      });
    } else if(Array.isArray(r.transcript)) { transcript=r.transcript; }
    return {sentiment,pos,neu,neg,topics,resume,keyPoints,transcript,_score:score,tasks:r.tasks||[],sections:r.sections||[],compliance:r.compliance||[]};
  }
  function calcScoreFromSentiment(a){return a.sentiment==='positive'?Math.max(60,a.pos||65):a.sentiment==='negative'?Math.min(40,100-(a.neg||60)):50;}

  /* ══════════════════════════════════════════════
     MODAL — СКВОЗНОЙ БЛОК + ВКЛАДКИ
     Fix: grm → crm; одиночный lookupCrm
  ══════════════════════════════════════════════ */
  function openCallModal(callId, tab) {
    if(callId==='__bulk__') { document.getElementById('callModal').classList.add('open'); return; }
    var c=allLoadedCalls.find(function(x){return x.id===callId;}); if(!c) return;
    modalCallId=callId;
    modalActiveTab=tab||'overview';
    if(tab==='scriptcheck') modalScriptCheckResult=null;

    setText('modalPhone', c.phone);

    // CRM ссылка — FIX: один вызов, используем crm (не grm)
    var crmEl=document.getElementById('modalCrmLink');
    if(crmEl) {
      if(c._crmResolved) {
        renderModalCrmLink(crmEl, c._crmResolved);
      } else {
        crmEl.innerHTML='<span style="color:var(--muted);font-size:12px">⏳ Поиск...</span>';
        lookupCrm(c.phone, function(crm) {  // ← исправлено: crm (не grm)
          if(c) c._crmResolved=crm;
          if(crm) {
            renderModalCrmLink(crmEl, crm);
            refreshCrmChip(callId, crm);
          } else {
            crmEl.innerHTML='<span style="color:var(--muted);font-size:12px">Контакт не найден</span>';
          }
        });
      }
    }

    var metaEl=document.getElementById('modalMeta');
    if(metaEl) {
      metaEl.innerHTML=
        '<span class="modal-call-meta-chip">📅 '+fmtDate(c.ts)+' '+fmtTime(c.ts)+'</span>'+
        '<span class="modal-call-meta-chip">👤 '+esc(c.manager)+'</span>'+
        '<span class="modal-call-meta-chip">⏱ '+c.duration+'</span>'+
        (c.callType==='1'?'<span class="modal-call-meta-chip">📤 Исходящий</span>':
         c.callType==='2'?'<span class="modal-call-meta-chip">📲 Входящий</span>':
         c.callType==='3'?'<span class="modal-call-meta-chip">📲 Входящий</span>':
         c.callType==='4'?'<span class="modal-call-meta-chip">🔄 Обратный</span>':'');
    }

    var audioWrap=document.getElementById('modalAudioWrap');
    var audioPlayer=document.getElementById('modalAudioPlayer');
    if(c._recordUrl){audioWrap.style.display='';audioPlayer.src=c._recordUrl;}
    else{audioWrap.style.display='none';audioPlayer.src='';}

    var tabsEl=document.getElementById('modalTabs');
    if(c.analysis){
      tabsEl.style.display='';
      document.querySelectorAll('.modal-tab').forEach(function(b){b.classList.toggle('active',b.dataset.tab===modalActiveTab);});
      renderModalTab(modalActiveTab);
    } else {
      tabsEl.style.display='none';
      renderNoAnalysis(callId);
    }
    document.getElementById('callModal').classList.add('open');
  }

  function renderModalCrmLink(crmEl, crm) {
    crmEl.innerHTML='<span class="crm-chip" style="font-size:13px;border-bottom:none">'+
      '<span class="crm-chip-type">'+esc(crm.typeLabel||crm.type)+'</span>'+
      '<span style="border-bottom:1px dashed rgba(37,99,235,.3);cursor:pointer" id="modalCrmClickable">'+esc(crm.name)+'</span></span>';
    var el=crmEl.querySelector('#modalCrmClickable');
    if(el) el.addEventListener('click',function(){openCrmCard(crm);});
  }

  function renderNoAnalysis(callId) {
    document.getElementById('modalContent').innerHTML=
      '<div style="text-align:center;padding:28px 0">'+
        '<div style="font-size:40px;margin-bottom:12px">🎙️</div>'+
        '<div style="font-size:14px;font-weight:600;margin-bottom:8px">Звонок не проанализирован</div>'+
        '<div style="font-size:13px;color:var(--muted2);margin-bottom:18px">Запустите AI-анализ для получения транскрипта, инсайтов и проверки по скрипту</div>'+
        '<button class="btn btn-primary" onclick="App.analyzeCall(\''+callId+'\');App.closeModal();">🧠 Запустить анализ</button>'+
      '</div>';
  }

  function renderModalTab(tab) {
    modalActiveTab=tab;
    var c=allLoadedCalls.find(function(x){return x.id===modalCallId;}); if(!c||!c.analysis) return;
    var a=c.analysis;
    var html='';
    if(tab==='overview')      html=renderTabOverview(c,a);
    else if(tab==='transcript')  html=renderTabTranscript(a,c);
    else if(tab==='scriptcheck') html=renderTabScriptCheck(c);
    document.getElementById('modalContent').innerHTML=html;
    afterTabRender(tab,c,a);
  }

  function afterTabRender(tab,c,a) {
    if(tab==='transcript') {
      var srch=document.getElementById('transcriptSearch');
      if(srch) srch.addEventListener('input',function(){
        var q=this.value.toLowerCase();
        document.querySelectorAll('.msg-text').forEach(function(el){
          var orig=el.getAttribute('data-orig')||el.textContent;
          el.setAttribute('data-orig',orig);
          if(q&&orig.toLowerCase().indexOf(q)!==-1) el.innerHTML=orig.replace(new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),'<mark class="msg-highlight">$1</mark>');
          else el.textContent=orig;
        });
      });
      // Кнопка «Очистить анализ»
      var clearBtn=document.getElementById('clearAnalysisBtn');
      if(clearBtn) clearBtn.addEventListener('click',function(){
        var id=clearBtn.dataset.id;
        var cc=allLoadedCalls.find(function(x){return x.id===id;}); if(!cc) return;
        if(!confirm('Удалить сохранённый анализ этого звонка?')) return;
        cc.analysis=null;
        try{ var s=loadAnalyses(); delete s[id]; localStorage.setItem(LS_ANA,JSON.stringify(s)); }catch(e){}
        closeModal();
        updateAnalyzedRow(id);
      });
      // Кнопка «Повторить анализ»
      var reTransBtn=document.getElementById('reAnalyzeTranscriptBtn');
      if(reTransBtn) reTransBtn.addEventListener('click',function(){
        var id=reTransBtn.dataset.id;
        var cc=allLoadedCalls.find(function(x){return x.id===id;}); if(!cc) return;
        cc.analysis=null;
        closeModal(); setTimeout(function(){analyzeCall(id);},200);
      });
    }
    if(tab==='overview') {
      var reBtn=document.getElementById('reAnalyzeBtn');
      if(reBtn) reBtn.addEventListener('click',function(){
        var id=reBtn.dataset.id;
        var cc=allLoadedCalls.find(function(x){return x.id===id;}); if(cc) cc.analysis=null;
        closeModal(); setTimeout(function(){analyzeCall(id);},200);
      });
      var bx24Btn=document.getElementById('createBX24Task');
      if(bx24Btn) bx24Btn.addEventListener('click',function(){
        if(!c.analysis||!c.analysis.tasks||!c.analysis.tasks.length) return;
        BX24.callMethod('tasks.task.add',{fields:{TITLE:c.analysis.tasks[0],DESCRIPTION:buildComment(c.analysis)}},function(res){
          if(!res.error()) alert('✅ Задача создана в Bitrix24!');
        });
      });
    }
    if(tab==='scriptcheck') bindScriptCheckTab(c);
  }

  function closeModal() {
    var p=document.getElementById('modalAudioPlayer');
    if(p){p.pause();p.src='';}
    document.getElementById('callModal').classList.remove('open');
    modalCallId=null; modalScriptCheckResult=null;
  }

  /* ─── TAB: ОБЗОР — резюме после блока тональности ─── */
  function renderTabOverview(c,a) {
    var score=calcScore(a);
    var scoreCls=score>=75?'high':score>=50?'mid':'low';
    var SL={positive:'😊 Позитивная',neutral:'😐 Нейтральная',negative:'😡 Негативная'};
    var SC={positive:'#16a34a',neutral:'#9ca3af',negative:'#dc2626'};
    var sc=SC[a.sentiment]||'#9ca3af';
    var agentPct=a.agentTalkPct!=null?a.agentTalkPct:55;
    var clientPct=100-agentPct;

    // Резюме — показывается ПОСЛЕ блока тональности (со скриншота: заголовок + кнопки)
    var resumeHtml='';
    if(a.resume) {
      resumeHtml='<div class="resume-block">'+
        '<div class="resume-block-header">'+
          '<div class="resume-block-label">📄 Резюме</div>'+
          '<div style="display:flex;gap:6px">'+
            '<button class="btn btn-secondary sm" style="font-size:11px" onclick="(function(){'+
              'var el=document.getElementById(\'resumeText\');'+
              'if(navigator.clipboard&&el)navigator.clipboard.writeText(el.textContent).then(function(){alert(\'Скопировано!\');});'+
            '})()">⎘ Копировать</button>'+
          '</div>'+
        '</div>'+
        '<div id="resumeText" style="font-size:13px;line-height:1.65;color:var(--text)">'+esc(a.resume)+'</div>'+
      '</div>';
    }

    var tasksHtml='';
    if(a.tasks&&a.tasks.length) {
      tasksHtml='<div class="tasks-block"><div class="tasks-block-label">✅ Задачи к выполнению</div>'+
        a.tasks.map(function(t){return '<div class="task-item"><span style="color:var(--accent);margin-right:4px">•</span><span>'+esc(t)+'</span></div>';}).join('')+
        '<div style="margin-top:8px"><button class="btn btn-primary sm" id="createBX24Task">Создать задачу в Bitrix24</button></div></div>';
    }

    // Ключевые моменты (перенесены из вкладки Инсайты)
    var keyPointsHtml='';
    if(a.keyPoints&&a.keyPoints.length) {
      keyPointsHtml='<div class="result-section-title" style="margin-top:14px">🧠 Ключевые моменты</div>'+
        '<div class="kp-block">'+
        a.keyPoints.map(function(kp){return '<div class="kp-item"><span class="kp-icon">'+kp.icon+'</span><div><div class="kp-lbl">'+esc(kp.label)+'</div><div class="kp-txt">'+esc(kp.text)+'</div></div></div>';}).join('')+
        '</div>';
    }

    // Смарт-теги (перенесены из вкладки Инсайты)
    var tagsHtml2='';
    if(a.topics&&a.topics.length) {
      tagsHtml2='<div class="result-section-title" style="margin-top:14px">🏷️ Темы разговора</div>'+
        '<div class="smart-tags" style="margin-bottom:14px">'+a.topics.map(function(t){return '<span class="smart-tag">'+esc(t)+'</span>';}).join('')+'</div>';
    }

    return '<div class="modal-tab-panel active">'+
      '<div class="overview-top">'+
        '<div class="score-circle '+scoreCls+'">'+(score!=null?score:'—')+'<small>из 100</small></div>'+
        '<div>'+
          '<div class="ov-tone" style="color:'+sc+'">'+((a.sentiment&&SL[a.sentiment])||'—')+'</div>'+
        '</div>'+
        '<div></div>'+
      '</div>'+
      '<div class="ov-cols">'+
        '<div class="ov-col"><div class="ov-col-val" style="color:#16a34a">'+a.pos+'%</div><div class="ov-col-lbl">😊 Позитив</div></div>'+
        '<div class="ov-col"><div class="ov-col-val" style="color:#9ca3af">'+a.neu+'%</div><div class="ov-col-lbl">😐 Нейтраль</div></div>'+
        '<div class="ov-col"><div class="ov-col-val" style="color:#dc2626">'+a.neg+'%</div><div class="ov-col-lbl">😡 Негатив</div></div>'+
      '</div>'+
      '<div class="tone-bar-bg" style="margin-bottom:12px"><div class="tone-seg">'+
        '<span style="width:'+a.pos+'%;background:#16a34a;border-radius:4px 0 0 4px"></span>'+
        '<span style="width:'+a.neu+'%;background:#f59e0b"></span>'+
        '<span style="width:'+a.neg+'%;background:#dc2626;border-radius:0 4px 4px 0"></span>'+
      '</div></div>'+
      resumeHtml+
      tagsHtml2+
      keyPointsHtml+
      '<div class="talk-ratio-label">⚖️ Говорит / Слушает</div>'+
      '<div class="talk-ratio-bar">'+
        '<span style="width:'+agentPct+'%;background:var(--accent)">'+agentPct+'%</span>'+
        '<span style="width:'+clientPct+'%;background:#8b5cf6">'+clientPct+'%</span>'+
      '</div>'+
      '<div class="talk-ratio-legend" style="margin-bottom:10px">'+
        '<span><span class="talk-dot" style="background:var(--accent)"></span> Сотрудник</span>'+
        '<span><span class="talk-dot" style="background:#8b5cf6"></span> Клиент</span>'+
      '</div>'+
      tasksHtml+
      '<div class="result-actions">'+
        '<button class="btn btn-ghost sm" id="reAnalyzeBtn" data-id="'+c.id+'">🔄 Перезапустить</button>'+
        (cfg.tgSaveBx==='1'?'<button class="btn btn-secondary sm" onclick="App.saveCommentNow(\''+c.id+'\')">💾 В Bitrix24</button>':'')+
      '</div>'+
    '</div>';
  }

  /* ─── TAB: РАСШИФРОВКА ─── */
  function renderTabTranscript(a, c) {
    var trHTML=(a.transcript&&a.transcript.length)?
      a.transcript.map(function(m){
        return '<div class="msg"><div class="msg-avatar '+m.role+'">'+(m.role==='agent'?'А':'К')+'</div>'+
          '<div class="msg-body"><div class="msg-meta"><strong>'+esc(m.name)+'</strong><span>'+m.time+'</span></div>'+
          '<div class="msg-text" data-orig="'+esc(m.text)+'">'+esc(m.text)+'</div></div></div>';
      }).join(''):'<p class="empty-hint">Транскрипт недоступен</p>';
    return '<div class="modal-tab-panel active">'+
      '<div class="transcript-search-bar">'+
        '<input type="text" id="transcriptSearch" placeholder="🔍 Поиск по расшифровке...">'+
        '<button class="btn btn-ghost sm" onclick="(function(){var t=document.querySelector(\'.transcript-full\');if(t&&navigator.clipboard)navigator.clipboard.writeText(t.innerText).then(function(){alert(\'Скопировано!\');});})()">⎘ Копировать</button>'+
      '</div>'+
      '<div class="transcript-full">'+trHTML+'</div>'+
      '<div class="transcript-actions">'+
        '<button class="btn btn-ghost sm" id="clearAnalysisBtn" data-id="'+(c?c.id:'')+'">🗑 Очистить анализ</button>'+
        '<button class="btn btn-secondary sm" id="reAnalyzeTranscriptBtn" data-id="'+(c?c.id:'')+'">🔄 Повторить анализ</button>'+
      '</div>'+
    '</div>';
  }

  /* ─── TAB: ИНСАЙТЫ ─── */
  function renderTabInsights(c,a) {
    var tagsHtml=(a.topics&&a.topics.length)?
      '<div class="result-section-title">🏷️ Смарт-теги</div>'+
      '<div class="smart-tags">'+a.topics.map(function(t){return '<span class="smart-tag">'+esc(t)+'</span>';}).join('')+'</div>':'';
    var kpHtml='';
    if(a.keyPoints&&a.keyPoints.length) {
      kpHtml='<div class="result-section-title">🧠 Ключевые моменты</div>'+
        '<div class="kp-block">'+
        a.keyPoints.map(function(kp){return '<div class="kp-item"><span class="kp-icon">'+kp.icon+'</span><div><div class="kp-lbl">'+esc(kp.label)+'</div><div class="kp-txt">'+esc(kp.text)+'</div></div></div>';}).join('')+
        '</div>';
    }
    var sectionsHtml='';
    if(a.sections&&a.sections.length) {
      sectionsHtml='<div class="result-section-title">📊 Оценки по разделам</div>'+
        a.sections.map(function(sec){
          var spill=sec.score>=75?'score-pill-green':sec.score>=50?'score-pill-yellow':'score-pill-red';
          var items=(sec.done||[]).map(function(item){return '<div class="insight-row"><span class="insight-check ok">✓</span><span class="insight-row-label">'+esc(item)+'</span></div>';}).join('')+
            (sec.missed||[]).map(function(item){return '<div class="insight-row"><span class="insight-check fail">✗</span><span class="insight-row-label fail">'+esc(item)+'</span></div>';}).join('');
          return '<div class="insight-section"><div class="insight-section-header"><div class="insight-section-title">'+esc(sec.name)+'</div><div class="insight-score-pill '+spill+'">'+sec.score+'/100</div></div>'+(items?'<div class="insight-section-body">'+items+'</div>':'')+' </div>';
        }).join('');
    }
    var complianceHtml='';
    if(a.compliance&&a.compliance.length) {
      complianceHtml='<div class="result-section-title">🛡️ Соблюдение регламента</div>'+
        a.compliance.map(function(item){return '<div class="compliance-item"><span class="compliance-label">'+esc(item.label)+'</span><span class="compliance-badge '+(item.ok?'ok':'fail')+'">'+(item.ok?'✓ Соблюдено':'✗ Не соблюдено')+'</span></div>';}).join('');
    }
    return '<div class="modal-tab-panel active">'+tagsHtml+kpHtml+sectionsHtml+complianceHtml+
      '<div class="result-actions"><button class="btn btn-ghost sm" id="reAnalyzeBtn" data-id="'+c.id+'">🔄 Перезапустить</button></div></div>';
  }

  /* ─── TAB: МОИ ПРОВЕРКИ ─── */
  function renderTabScriptCheck(c) {
    var scripts=loadScripts();
    if(!scripts.length) return '<div class="modal-tab-panel active"><div style="text-align:center;padding:28px 0"><div style="font-size:36px;margin-bottom:10px">📋</div><div style="font-weight:600;margin-bottom:6px">Нет скриптов</div><div style="color:var(--muted2);font-size:13px;margin-bottom:14px">Добавьте скрипт в разделе «Скрипты»</div><button class="btn btn-secondary sm" onclick="App.closeModal();App.showPage(\'scripts\')">Перейти к скриптам</button></div></div>';
    if(!c.analysis||!c.analysis.transcript||!c.analysis.transcript.length) return '<div class="modal-tab-panel active"><div style="text-align:center;padding:28px 0"><div style="font-size:36px;margin-bottom:10px">⚠️</div><div style="font-weight:600;margin-bottom:6px">Нет расшифровки</div><div style="color:var(--muted2);font-size:13px">Сначала запустите анализ звонка</div></div></div>';

    // Показываем текущий результат (из сессии или сохранённый в analysis)
    var savedChecks = c.analysis.scriptChecks || {};

    // Если есть активный результат в сессии — показываем его
    if(modalScriptCheckResult) {
      return '<div class="modal-tab-panel active">'+
        renderScriptCheckResultHtml(modalScriptCheckResult)+
        '<div style="margin-top:8px;font-size:12px;color:var(--green)">✅ Оценка звонка: '+modalScriptCheckResult.data.score+'/100</div>'+
        '<div style="margin-top:10px"><button class="btn btn-ghost sm" id="rerunScriptCheckBtn">🔄 Проверить снова</button></div></div>';
    }

    // Собираем HTML для кнопок скриптов — с индикатором сохранённого результата
    var scriptBtns=scripts.map(function(s){
      var hasSaved=!!savedChecks[s.id];
      return '<button class="btn '+(hasSaved?'btn-audit':'btn-secondary')+' sm run-script-check-btn" data-sid="'+s.id+'" style="width:100%;justify-content:flex-start;margin-bottom:6px">'+
        '📋 '+esc(s.name)+(hasSaved?' <span style="font-size:10px;opacity:.7">✓ проверен</span>':'')+
      '</button>';
    }).join('');

    // Если есть хотя бы один сохранённый — показываем последний
    var savedIds=Object.keys(savedChecks);
    var lastSaved = savedIds.length ? savedChecks[savedIds[savedIds.length-1]] : null;

    var savedHtml='';
    if(lastSaved) {
      savedHtml='<div style="margin-bottom:14px">'+
        '<div style="font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;margin-bottom:8px">Последняя проверка</div>'+
        renderScriptCheckResultHtml(lastSaved)+
        '<div style="margin-top:8px"><button class="btn btn-ghost sm" id="clearLastCheckBtn">✕ Очистить</button></div>'+
      '</div>'+
      '<div style="font-size:11px;font-weight:700;color:var(--muted2);text-transform:uppercase;margin:12px 0 8px">Проверить по другому скрипту</div>';
    }

    return '<div class="modal-tab-panel active">'+
      savedHtml+
      '<div class="scriptcheck-select"><div id="scriptCheckBtnRow">'+scriptBtns+'</div></div>'+
      '<div id="scriptCheckResultArea"></div></div>';
  }

  function bindScriptCheckTab(c) {
    var container=document.getElementById('scriptCheckBtnRow');
    if(container) {
      container.querySelectorAll('.run-script-check-btn').forEach(function(btn){
        btn.addEventListener('click',function(){ runScriptCheck(c, btn.dataset.sid); });
      });
    }
    var rerun=document.getElementById('rerunScriptCheckBtn');
    if(rerun) rerun.addEventListener('click',function(){
      // Очищаем только текущий результат сессии, сохранённые в analysis остаются
      modalScriptCheckResult=null;
      renderModalTab('scriptcheck');
      bindScriptCheckTab(c);
    });
    var clearLast=document.getElementById('clearLastCheckBtn');
    if(clearLast) clearLast.addEventListener('click',function(){
      if(c.analysis) { c.analysis.scriptChecks={}; saveAnalysis(c.id, c.analysis); }
      renderModalTab('scriptcheck');
      bindScriptCheckTab(c);
    });
  }

  /* ─── Фоновый запуск: мини-попап выбора скрипта ─── */
  function openBgScriptSelectModal(callId) {
    var c=allLoadedCalls.find(function(x){return x.id===callId;}); if(!c) return;
    var scripts=loadScripts();
    if(!scripts.length) { alert('Добавьте скрипт в разделе «Скрипты» перед проверкой.'); return; }
    if(!getActiveServerUrl()) { alert('Настройте URL сервера в ⚙️ Настройках.'); return; }
    if(!c._recordUrl) { alert('У этого звонка нет записи для анализа.'); return; }

    // Мини-модал поверх таблицы (dropdown-style)
    var existing=document.getElementById('bgScriptPopup');
    if(existing) existing.remove();

    var btns=scripts.map(function(s){
      return '<button class="btn btn-secondary sm" data-sid="'+s.id+'" style="width:100%;text-align:left;margin-bottom:5px">📋 '+esc(s.name)+'</button>';
    }).join('');

    var popup=document.createElement('div');
    popup.id='bgScriptPopup';
    popup.className='bg-script-popup';
    popup.innerHTML=
      '<div class="bg-script-popup-title">Выберите скрипт для проверки</div>'+
      '<div class="bg-script-popup-sub">Расшифровка + анализ пройдут в фоне</div>'+
      btns+
      '<button class="btn btn-ghost sm" id="bgScriptPopupClose" style="width:100%;margin-top:4px">Отмена</button>';
    document.body.appendChild(popup);

    setTimeout(function(){
      document.addEventListener('click', function closePop(e){
        if(!popup.contains(e.target)){ popup.remove(); document.removeEventListener('click',closePop); }
      });
    }, 10);

    popup.querySelector('#bgScriptPopupClose').addEventListener('click',function(){ popup.remove(); });
    popup.querySelectorAll('[data-sid]').forEach(function(btn){
      btn.addEventListener('click', function(){
        popup.remove();
        var scriptId = btn.dataset.sid;
        // Если расшифровка уже есть — сразу к анализу по скрипту
        if(c.analysis && c.analysis.transcript && c.analysis.transcript.length) {
          startBgScriptCheck(c, scriptId);
        } else {
          // Сначала делаем полный анализ, потом скрипт-чек
          startBgAnalyzeAndScript(c, scriptId);
        }
      });
    });
  }

  function startBgAnalyzeAndScript(c, scriptId) {
    if(!c._recordUrl) return;
    var wUrl=getActiveServerUrl();

    bgScriptJobs[c.id]={ status:'running', scriptId:scriptId };
    // Показываем ⏳
    document.querySelectorAll('.audit-cell[data-id="'+c.id+'"]').forEach(function(td){
      td.innerHTML='<button class="btn btn-ghost sm" disabled style="opacity:.6">⏳ Анализ...</button>';
    });

    showBgToast('⏳ Расшифровка звонка...');

    function onAnalysisDone(failed) {
      if(failed) {
        bgScriptJobs[c.id]={status:'error'};
        updateAnalyzedRow(c.id);
        showBgToast('❌ Не удалось расшифровать звонок');
        return;
      }
      showBgToast('⏳ Проверка по скрипту...');
      startBgScriptCheck(c, scriptId);
    }

    // Пробуем по URL
    _sendUrl(c, wUrl, c._recordUrl, c.id, function(urlFailed){
      if(!urlFailed) { onAnalysisDone(false); return; }
      _downloadAudio(c._recordUrl, function(err, b64){
        if(err) { onAnalysisDone(true); return; }
        // sendBase64 без колбека — ждём через polling
        setAuditLoading(c.id,'⏳ Расшифровка...');
        xhrPost(wUrl+'/transcribe',{audio_base64:b64,language:cfg.whisperLang||'ru'},60000,function(err,result){
          if(err){ onAnalysisDone(true); return; }
          var tr=(result.text||'').trim(); if(!tr){ onAnalysisDone(true); return; }
          xhrPost(getActiveServerUrl()+'/analyze-text',buildAnalyzePayload(c,tr),60000,function(err2,result2){
            setAuditNormal(c.id);
            if(err2){ onAnalysisDone(true); return; }
            finishAnalysis(c,result2,tr);
            onAnalysisDone(false);
          });
        });
      });
    });
  }

  function startBgScriptCheck(c, scriptId) {
    var scripts=loadScripts();
    var script=scripts.find(function(x){return x.id===scriptId;}); if(!script) return;

    // Отмечаем что идёт фоновый анализ
    bgScriptJobs[c.id]={ status:'running', scriptId:scriptId };
    // Перерисуем кнопку ⏳
    document.querySelectorAll('.audit-cell[data-id="'+c.id+'"]').forEach(function(td){
      td.innerHTML=auditBtnHtml(c);
    });

    var transcriptText=c.analysis.transcript.map(function(m){
      return (m.role==='agent'?'МЕНЕДЖЕР: ':'КЛИЕНТ: ')+m.text;
    }).join('\n');

    var payload={
      transcript:  transcriptText,
      script_name: script.name,
      sections:    script.sections,
      model:       cfg.dsModel||'deepseek-chat'
    };

    xhrPost(getActiveServerUrl()+'/script-check', payload, 120000, function(err, result){
      if(err) {
        // Fallback
        runScriptCheckFallback(c, script, transcriptText, null, function(parsed){
          completeBgScriptCheck(c, script, scriptId, parsed);
        });
        return;
      }
      completeBgScriptCheck(c, script, scriptId, result);
    });
  }

  function completeBgScriptCheck(c, script, scriptId, rawResult) {
    var parsed=normalizeScriptCheckResult(rawResult, script);
    var checkResult={script:script, data:parsed};

    bgScriptJobs[c.id]={ status:'done', scriptId:scriptId, checkResult:checkResult };

    // Сохраняем в analysis
    if(!c.analysis.scriptChecks) c.analysis.scriptChecks={};
    c.analysis.scriptChecks[scriptId]=checkResult;
    c.analysis._score=parsed.score;
    c.analysis._scoreFromScript=true;
    saveAnalysis(c.id, c.analysis);
    updateAnalyzedRow(c.id);

    // Тост-уведомление
    showBgToast('✅ Проверка завершена: '+esc(c.contact)+' — '+parsed.score+'/100');
  }

  function showBgToast(msg) {
    var t=document.createElement('div');
    t.className='bg-toast';
    t.innerHTML=msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.classList.add('show'); }, 10);
    setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); },400); }, 4000);
  }

  function runScriptCheck(c, scriptId) {
    var scripts=loadScripts();
    var script=scripts.find(function(x){return x.id===scriptId;}); if(!script) return;
    if(!getActiveServerUrl()){alert('Настройте URL сервера в ⚙️ Настройках.');return;}

    var resultArea=document.getElementById('scriptCheckResultArea');
    if(resultArea) resultArea.innerHTML='<div class="loading-row" style="padding:14px 0"><span class="spinner"></span>&nbsp; AI проверяет по скрипту «'+esc(script.name)+'»...</div>';

    // Собираем транскрипт
    var transcriptText=c.analysis.transcript.map(function(m){
      return (m.role==='agent'?'МЕНЕДЖЕР: ':'КЛИЕНТ: ')+m.text;
    }).join('\n');

    // Payload для нового эндпоинта /script-check
    var payload = {
      transcript:   transcriptText,
      script_name:  script.name,
      sections:     script.sections,   // [{name, items:[]}]
      model:        cfg.dsModel||'deepseek-chat'
    };

    xhrPost(getActiveServerUrl()+'/script-check', payload, 120000, function(err, result){
      if(err){
        // Fallback: /script-check не задеплоен — пробуем через /analyze-text
        if(err.indexOf('404')!==-1||err.indexOf('endpoint')!==-1||err.indexOf('HTTP 4')!==-1) {
          runScriptCheckFallback(c, script, transcriptText, resultArea);
        } else {
          if(resultArea) resultArea.innerHTML='<div style="color:var(--red);padding:14px 0;font-size:13px">Ошибка: '+esc(err)+'<br><small>Убедитесь что задеплоен Worker v8</small></div>';
        }
        return;
      }
      finishScriptCheck(c, script, scriptId, result, resultArea);
    });
  }

  // Fallback через /analyze-text (для старого Worker v7)
  function runScriptCheckFallback(c, script, transcriptText, resultArea, doneCb) {
    var allChecks=[];
    script.sections.forEach(function(sec){
      sec.items.forEach(function(item){ allChecks.push({section:sec.name,check:item}); });
    });

    var checkListText='';
    script.sections.forEach(function(sec, si){
      checkListText+='\n### Раздел '+(si+1)+': '+sec.name+'\n';
      sec.items.forEach(function(item, ii){
        checkListText+='  '+(si+1)+'.'+(ii+1)+'. '+item+'\n';
      });
    });

    var prompt =
      'Ты — эксперт по качеству продаж. Проверь расшифровку звонка по чек-листу скрипта.\n\n'+
      'СКРИПТ «'+script.name+'»:'+checkListText+'\n---\n'+
      'РАСШИФРОВКА ЗВОНКА:\n'+transcriptText.slice(0,4500)+'\n---\n'+
      'Верни ТОЛЬКО валидный JSON без markdown:\n'+
      '{"score":75,"summary":"Вывод","sections":[{"name":"Раздел","score":80,"results":[{"check":"пункт","verdict":"Да","evidence":"цитата"}]}]}';

    xhrPost(getActiveServerUrl()+'/analyze-text', {transcript: prompt, model: cfg.dsModel||'deepseek-chat'}, 120000, function(err2, result2){
      if(err2){
        if(resultArea) resultArea.innerHTML='<div style="color:var(--red);padding:14px 0;font-size:13px">Ошибка: '+esc(err2)+'</div>';
        return;
      }
      // Worker вернёт анализ как обычно — нужно извлечь JSON из текста
      var parsed = extractScriptCheckJson(result2, script);
      if(doneCb) { doneCb(parsed); return; }
      finishScriptCheck(c, script, script.id, parsed, resultArea);
    });
  }

  function extractScriptCheckJson(result, script) {
    // Ищем JSON во всех строковых полях ответа
    var raw='';
    if(typeof result==='object') {
      var keys=Object.keys(result);
      for(var i=0;i<keys.length;i++){
        var v=result[keys[i]];
        if(typeof v==='string'&&v.length>10){raw=v;break;}
      }
    }
    raw=raw.replace(/```json|```/g,'').trim();
    try{
      var p=JSON.parse(raw);
      if(p&&p.sections) return p;
    }catch(e){}
    // Ищем JSON-объект внутри строки
    var m=raw.match(/\{[\s\S]+\}/);
    if(m){try{var p2=JSON.parse(m[0]);if(p2&&p2.sections)return p2;}catch(e){}}

    // Fallback: создаём пустую структуру
    return {
      score: 0,
      summary: 'Не удалось распарсить ответ. Обновите Worker до v8.',
      sections: script.sections.map(function(sec){
        return {
          name: sec.name, score: 0,
          results: sec.items.map(function(item){
            return {check:item, verdict:'НП', evidence:'Требуется Worker v8 для корректной проверки'};
          })
        };
      })
    };
  }

  function finishScriptCheck(c, script, scriptId, result, resultArea) {
    // Нормализуем результат
    var parsed = normalizeScriptCheckResult(result, script);
    var checkResult = {script:script, data:parsed};
    modalScriptCheckResult = checkResult;

    // Сохраняем в analysis
    if(!c.analysis.scriptChecks) c.analysis.scriptChecks={};
    c.analysis.scriptChecks[scriptId] = checkResult;

    // Обновляем score звонка
    c.analysis._score = parsed.score;
    c.analysis._scoreFromScript = true;
    saveAnalysis(c.id, c.analysis);
    updateAnalyzedRow(c.id);

    if(resultArea) resultArea.innerHTML =
      renderScriptCheckResultHtml(checkResult)+
      '<div style="margin-top:8px;font-size:12px;color:var(--green)">✅ Оценка звонка обновлена: '+parsed.score+'/100</div>'+
      '<div style="margin-top:8px"><button class="btn btn-ghost sm" id="rerunScriptCheckBtn2">🔄 Проверить снова</button></div>';

    var rerun2=document.getElementById('rerunScriptCheckBtn2');
    if(rerun2) rerun2.addEventListener('click',function(){
      if(c.analysis.scriptChecks) delete c.analysis.scriptChecks[scriptId];
      saveAnalysis(c.id, c.analysis);
      modalScriptCheckResult=null;
      renderModalTab('scriptcheck');
      bindScriptCheckTab(c);
    });
  }

  function normalizeScriptCheckResult(r, script) {
    // Если пришёл правильный формат от /script-check
    if(r && Array.isArray(r.sections) && r.sections.length) {
      r.score = Math.min(100, Math.max(0, parseInt(r.score)||0));
      r.sections.forEach(function(sec){
        sec.score = Math.min(100, Math.max(0, parseInt(sec.score)||0));
        if(!Array.isArray(sec.results)) sec.results=[];
      });
      return r;
    }
    // Fallback: старый формат с flat results
    if(r && Array.isArray(r.results)) {
      var bySection={};
      r.results.forEach(function(res){
        var sName=res.section||'Общее';
        if(!bySection[sName]) bySection[sName]=[];
        bySection[sName].push(res);
      });
      var sections=Object.keys(bySection).map(function(sName){
        var results=bySection[sName];
        var yes=results.filter(function(x){return x.verdict==='Да';}).length;
        var score=results.length?Math.round(yes/results.length*100):0;
        return {name:sName, score:score, results:results};
      });
      var totalScore=sections.length?Math.round(sections.reduce(function(s,x){return s+x.score;},0)/sections.length):0;
      return {score:parseInt(r.score)||totalScore, summary:r.summary||'', sections:sections};
    }
    // Пустой fallback
    return {
      score: 0,
      summary: 'Ошибка получения данных',
      sections: script.sections.map(function(sec){
        return {name:sec.name, score:0, results:sec.items.map(function(item){return {check:item,verdict:'НП',evidence:'—'};})};
      })
    };
  }

  function renderScriptCheckResultHtml(checkResult) {
    var script=checkResult.script, d=checkResult.data;
    var score=d.score||0;
    var scoreCls=score>=75?'high':score>=50?'mid':'low';
    var isBulk=checkResult.isBulk;

    // Шапка с общим скором и выводом
    var headerHtml=
      '<div class="scriptcheck-result-header">'+
        '<div class="scriptcheck-title">📋 '+esc(script.name)+(isBulk?' <span style="font-size:11px;color:var(--muted2)">('+checkResult.callIds.length+' звонков)</span>':'')+'</div>'+
        '<div class="scriptcheck-score-row">'+
          '<div class="score-circle '+scoreCls+'" style="width:56px;height:56px;font-size:18px;flex-shrink:0">'+score+'<small>из 100</small></div>'+
          (d.summary?'<div class="scriptcheck-summary">'+esc(d.summary)+'</div>':'')+
        '</div>'+
      '</div>';

    // Секции с прогресс-баром и пунктами
    var sectionsHtml='';
    if(d.sections&&d.sections.length) {
      sectionsHtml=d.sections.map(function(sec){
        var ss=sec.score||0;
        var ssCls=ss>=75?'#16a34a':ss>=50?'#d97706':'#dc2626';
        var ssBg=ss>=75?'#dcfce7':ss>=50?'#fef3c7':'#fee2e2';
        var results=sec.results||[];
        var doneCount=results.filter(function(r){return r.verdict==='Да';}).length;

        var rowsHtml=results.map(function(r){
          var v=r.verdict||'НП';
          var vClass=v==='Да'?'verdict-yes':v==='Нет'?'verdict-no':'verdict-na';
          var vIcon=v==='Да'?'✓':v==='Нет'?'✗':'—';
          return '<div class="script-ai-row">'+
            '<span class="script-ai-verdict '+vClass+'">'+vIcon+' '+esc(v)+'</span>'+
            '<div style="min-width:0">'+
              '<div class="script-ai-text">'+esc(r.check)+'</div>'+
              (r.evidence?'<div class="script-ai-evidence">'+esc(r.evidence)+'</div>':'')+
            '</div>'+
          '</div>';
        }).join('');

        return '<div class="script-section-result">'+
          '<div class="script-section-result-header">'+
            '<div class="script-section-result-name">'+esc(sec.name)+'</div>'+
            '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">'+
              '<span style="font-size:11px;color:var(--muted2)">'+doneCount+'/'+results.length+'</span>'+
              '<span style="font-size:12px;font-weight:700;padding:2px 8px;border-radius:12px;background:'+ssBg+';color:'+ssCls+'">'+ss+'</span>'+
            '</div>'+
          '</div>'+
          '<div class="script-section-progress">'+
            '<div style="width:'+ss+'%;background:'+ssCls+';height:100%;border-radius:3px;transition:width .4s"></div>'+
          '</div>'+
          (rowsHtml?'<div class="script-section-rows">'+rowsHtml+'</div>':'')+
        '</div>';
      }).join('');
    }

    return '<div class="scriptcheck-result">'+headerHtml+sectionsHtml+'</div>';
  }

  /* ══════════════════════════════════════════════
     SCRIPTS PAGE
  ══════════════════════════════════════════════ */
  var activeScriptId=null;

  function bindScriptsPage() {
    document.getElementById('addScriptBtn').addEventListener('click',openScriptAddModal);
    document.getElementById('addScriptBtn2').addEventListener('click',openScriptAddModal);
  }

  function renderScriptsList() {
    var scripts=loadScripts();
    var list=document.getElementById('scriptsList'); if(!list) return;
    updateScriptsBadge();
    if(!scripts.length) {
      list.innerHTML='<div class="empty-hint" style="padding:24px;text-align:center">Нет скриптов. Добавьте первый!</div>';
      document.getElementById('scriptsDetailPanel').innerHTML='<div class="scripts-empty"><div class="scripts-empty-icon">📋</div><div class="scripts-empty-title">Нет скриптов</div><div class="scripts-empty-sub">Добавьте первый скрипт, чтобы проверять расшифровки звонков</div><button class="btn btn-primary" style="margin-top:16px" id="addScriptBtn2">+ Добавить скрипт</button></div>';
      document.getElementById('addScriptBtn2').addEventListener('click',openScriptAddModal);
      return;
    }
    list.innerHTML=scripts.map(function(s){
      return '<div class="script-item'+(activeScriptId===s.id?' active':'')+'" data-sid="'+s.id+'">'+
        '<div class="script-item-name">'+esc(s.name)+'</div>'+
        '<div class="script-item-meta">'+(s.sections?s.sections.length+' разделов':'')+' · '+new Date(s.createdAt).toLocaleDateString('ru')+'</div>'+
      '</div>';
    }).join('');
    list.querySelectorAll('.script-item').forEach(function(el){
      el.addEventListener('click',function(){activeScriptId=el.dataset.sid;renderScriptsList();renderScriptDetail(activeScriptId);});
    });
    if(activeScriptId) renderScriptDetail(activeScriptId);
    else if(scripts.length){ activeScriptId=scripts[0].id; renderScriptDetail(scripts[0].id); }
  }

  function renderScriptDetail(scriptId) {
    var scripts=loadScripts();
    var s=scripts.find(function(x){return x.id===scriptId;}); if(!s) return;
    var panel=document.getElementById('scriptsDetailPanel');
    var sectionsHtml=(s.sections||[]).map(function(sec){
      return '<div class="script-section">'+
        '<div class="script-section-header"><div class="script-section-name">'+esc(sec.name)+'</div><span style="font-size:11px;color:var(--muted)">'+sec.items.length+' пунктов</span></div>'+
        '<div class="script-items-list">'+
        sec.items.map(function(item){return '<div class="script-check-item"><input type="checkbox" title="Отметить выполнено"><span class="script-check-text">'+esc(item)+'</span></div>';}).join('')+
        '</div></div>';
    }).join('');
    panel.innerHTML=
      '<div class="scripts-detail-header"><div class="scripts-detail-title">'+esc(s.name)+'</div>'+
      '<button class="btn btn-secondary sm edit-script-btn" data-sid="'+s.id+'">✏️ Редактировать</button>'+
      '<button class="btn btn-ghost sm delete-script-btn" data-sid="'+s.id+'" style="color:var(--red)">🗑️</button></div>'+
      '<div class="scripts-detail-body">'+sectionsHtml+'</div>';
    panel.querySelectorAll('.script-check-item input').forEach(function(cb){
      cb.addEventListener('change',function(){cb.nextElementSibling.classList.toggle('checked-text',cb.checked);});
    });
    panel.querySelector('.delete-script-btn').addEventListener('click',function(){
      if(!confirm('Удалить скрипт «'+s.name+'»?')) return;
      saveScripts(loadScripts().filter(function(x){return x.id!==s.id;}));
      activeScriptId=null; renderScriptsList();
    });
    panel.querySelector('.edit-script-btn').addEventListener('click',function(){
      document.getElementById('scriptNameInput').value=s.name;
      document.getElementById('scriptTextInput').value=s.rawText||'';
      document.getElementById('scriptAddModal').classList.add('open');
      document.getElementById('scriptAddSaveBtn').dataset.editId=s.id;
    });
  }

  function openScriptAddModal(){
    document.getElementById('scriptNameInput').value='';
    document.getElementById('scriptTextInput').value='';
    delete document.getElementById('scriptAddSaveBtn').dataset.editId;
    document.getElementById('scriptAddModal').classList.add('open');
  }
  function closeScriptAddModal(){document.getElementById('scriptAddModal').classList.remove('open');}

  function saveNewScript(){
    var name=document.getElementById('scriptNameInput').value.trim();
    var text=document.getElementById('scriptTextInput').value.trim();
    if(!name){alert('Введите название');return;}
    if(!text){alert('Введите текст скрипта');return;}
    var sections=parseScriptText(text);
    var scripts=loadScripts();
    var editId=document.getElementById('scriptAddSaveBtn').dataset.editId;
    if(editId){var idx=scripts.findIndex(function(x){return x.id===editId;});if(idx!==-1)scripts[idx]={id:editId,name,sections,rawText:text,createdAt:scripts[idx].createdAt};}
    else scripts.push({id:Date.now().toString(),name,sections,rawText:text,createdAt:Date.now()});
    saveScripts(scripts); closeScriptAddModal(); renderScriptsList(); updateScriptsBadge();
  }

  function parseScriptText(text) {
    var lines=text.split('\n'), sections=[], currentSection=null;
    lines.forEach(function(line){
      var trimmed=line.trim(); if(!trimmed) return;
      if(/^#{1,3}\s+/.test(trimmed)){currentSection={name:trimmed.replace(/^#{1,3}\s+/,'').trim(),items:[]};sections.push(currentSection);}
      else if(/^[•\-\*]\s+|^\d+[.)]\s+/.test(trimmed)){
        var item=trimmed.replace(/^[•\-\*]\s+|^\d+[.)]\s+/,'').trim();
        if(item){if(!currentSection){currentSection={name:'Общее',items:[]};sections.push(currentSection);}currentSection.items.push(item);}
      } else if(trimmed.length>5&&!/^(\*|_|---)/.test(trimmed)){
        if(!currentSection){currentSection={name:'Общее',items:[]};sections.push(currentSection);}
        currentSection.items.push(trimmed);
      }
    });
    return sections.filter(function(s){return s.items.length>0;});
  }

  function updateScriptsBadge(){
    var count=loadScripts().length;
    var badge=document.getElementById('scriptsBadge'); if(badge) badge.textContent=count||'';
  }

  /* ══════════════════════════════════════════════
     SETTINGS — DEPT LIST
  ══════════════════════════════════════════════ */
  function renderSettingsDeptList() {
    var container=document.getElementById('settingsDeptList'); if(!container) return;
    var deptMap={};
    allManagers.forEach(function(m){ var key=m.deptName||'Без отдела'; if(!deptMap[key]) deptMap[key]=[]; deptMap[key].push(m); });
    if(!Object.keys(deptMap).length){container.innerHTML='<div class="empty-hint" style="padding:16px">Нет сотрудников</div>';return;}
    var html='';
    Object.keys(deptMap).sort().forEach(function(deptName){
      var members=deptMap[deptName];
      var allSelected=!cfg.allowedUsers||members.every(function(m){return cfg.allowedUsers.indexOf(m.id)!==-1;});
      html+='<div class="dept-item" data-dept="'+esc(deptName)+'">'+
        '<div class="dept-header" data-dept-toggle="'+esc(deptName)+'">'+
          '<input type="checkbox" class="dept-all-cb" data-dept="'+esc(deptName)+'" '+(allSelected?'checked':'')+' style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;flex-shrink:0" onclick="event.stopPropagation()">'+
          '<span style="font-weight:600;font-size:12px">'+esc(deptName)+'</span>'+
          '<span style="font-size:10px;color:var(--muted);margin-left:6px">('+members.length+')</span>'+
          '<span class="dept-toggle-icon">▶</span>'+
        '</div>'+
        '<div class="dept-members" data-dept-body="'+esc(deptName)+'">'+
        members.map(function(m){
          var sel=!cfg.allowedUsers||cfg.allowedUsers.indexOf(m.id)!==-1;
          return '<div class="dept-member"><input type="checkbox" class="staff-allowed-cb" data-uid="'+m.id+'" data-dept="'+esc(deptName)+'" '+(sel?'checked':'')+'>'+
            '<span class="dept-member-name">'+esc(m.name)+'</span></div>';
        }).join('')+
        '</div></div>';
    });
    container.innerHTML=html;

    // Синхронизируем галочки отделов по фактическому состоянию сотрудников
    function _syncDeptCb(deptName) {
      var deptCb=container.querySelector('.dept-all-cb[data-dept="'+deptName+'"]');
      if(!deptCb) return;
      var memberCbs=Array.from(container.querySelectorAll('.staff-allowed-cb[data-dept="'+deptName+'"]'));
      if(!memberCbs.length) return;
      var n=memberCbs.filter(function(m){return m.checked;}).length;
      deptCb.checked=n===memberCbs.length;
      deptCb.indeterminate=n>0&&n<memberCbs.length;
    }
    Object.keys(deptMap).forEach(function(d){ _syncDeptCb(d); });

    container.querySelectorAll('[data-dept-toggle]').forEach(function(header){
      header.addEventListener('click',function(){
        var dn=header.dataset.deptToggle;
        var body=container.querySelector('[data-dept-body="'+dn+'"]');
        var icon=header.querySelector('.dept-toggle-icon');
        if(body){body.classList.toggle('open');if(icon) icon.classList.toggle('open');}
      });
    });

    container.querySelectorAll('.dept-all-cb').forEach(function(cb){
      cb.addEventListener('change',function(){
        cb.indeterminate=false;
        _toggleDept(cb.checked, cb.dataset.dept);
        container.querySelectorAll('.staff-allowed-cb[data-dept="'+cb.dataset.dept+'"]').forEach(function(mcb){
          mcb.checked=cb.checked||!cfg.allowedUsers;
        });
        updateSettingsStaffCount();
      });
    });

    container.querySelectorAll('.staff-allowed-cb').forEach(function(cb){
      cb.addEventListener('change',function(){
        _toggleStaff(cb);
        _syncDeptCb(cb.dataset.dept);
        updateSettingsStaffCount();
      });
    });

    document.getElementById('settingsSelectAllStaff').onclick=function(){cfg.allowedUsers=null;renderSettingsDeptList();updateSettingsStaffCount();};
    document.getElementById('settingsClearAllStaff').onclick=function(){cfg.allowedUsers=[];renderSettingsDeptList();updateSettingsStaffCount();};
    updateSettingsStaffCount();
  }

  function _toggleDept(checked, deptName) {
    var members=allManagers.filter(function(m){return (m.deptName||'Без отдела')===deptName;});
    var ids=members.map(function(m){return m.id;});
    if(checked) {
      if(!cfg.allowedUsers) return; // всё и так включено
      ids.forEach(function(id){if(cfg.allowedUsers.indexOf(id)===-1) cfg.allowedUsers.push(id);});
    } else {
      if(!cfg.allowedUsers) {
        // все были выбраны — переходим в явный список без этого отдела
        cfg.allowedUsers=allManagers.filter(function(m){return ids.indexOf(m.id)===-1;}).map(function(m){return m.id;});
      } else {
        cfg.allowedUsers=cfg.allowedUsers.filter(function(x){return ids.indexOf(x)===-1;});
      }
    }
  }

  function _toggleStaff(cb) {
    var uid=cb.dataset.uid;
    if(cb.checked){
      if(!cfg.allowedUsers) return;
      if(cfg.allowedUsers.indexOf(uid)===-1) cfg.allowedUsers.push(uid);
    } else {
      if(!cfg.allowedUsers){
        cfg.allowedUsers=allManagers.filter(function(m){return m.id!==uid;}).map(function(m){return m.id;});
      } else {
        cfg.allowedUsers=cfg.allowedUsers.filter(function(x){return x!==uid;});
      }
    }
  }

  function updateSettingsStaffCount(){
    var el=document.getElementById('settingsStaffCount'); if(!el) return;
    el.textContent=!cfg.allowedUsers?'Все сотрудники ('+allManagers.length+')':cfg.allowedUsers.length?'Выбрано: '+cfg.allowedUsers.length+' из '+allManagers.length:'Никто не выбран';
  }

  /* ══════════════════════════════════════════════
     SETTINGS
  ══════════════════════════════════════════════ */
  function loadSettingsUI(){
    var el;
    el=document.getElementById('cfWorkerUrl');  if(el) el.value=cfg.cfUrl||'';
    el=document.getElementById('vdsUrl');        if(el) el.value=cfg.vdsUrl||'';
    el=document.getElementById('vdsApiKey');     if(el) el.value=cfg.vdsApiKey||'';
    el=document.getElementById('dsModel');       if(el) el.value=cfg.dsModel||'deepseek-chat';
    el=document.getElementById('whisperLang');   if(el) el.value=cfg.whisperLang||'ru';
    el=document.getElementById('tgSaveBx');      if(el) cfg.tgSaveBx==='1'?el.classList.add('on'):el.classList.remove('on');
    el=document.getElementById('tgAlertNeg');    if(el) cfg.tgAlertNeg==='1'?el.classList.add('on'):el.classList.remove('on');
    // Минимальная длительность
    el=document.getElementById('settingsMinDuration');
    if(el) el.value=activeFilters.minDuration!=null?activeFilters.minDuration:10;
    // Тип CRM-сущности
    ['crmTypeCompany','crmTypeLead','crmTypeContact','crmTypeNone'].forEach(function(id){
      var cb=document.getElementById(id); if(!cb) return;
      cb.checked=cfg.crmEntityTypes.indexOf(cb.value)!==-1;
      cb.onchange=function(){
        if(cb.checked){ if(cfg.crmEntityTypes.indexOf(cb.value)===-1) cfg.crmEntityTypes.push(cb.value); }
        else { cfg.crmEntityTypes=cfg.crmEntityTypes.filter(function(v){return v!==cb.value;}); }
      };
    });
    // Воронки — синхронизируем черновик с активным фильтром
    draftFunnelStages=activeFilters.funnelStages.slice();
    renderSettingsFunnelList();
    // Активный режим
    applyModeSwitch(cfg.serverMode||'worker');
  }

  function applyModeSwitch(mode) {
    cfg.serverMode=mode;
    document.querySelectorAll('.mode-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.mode===mode); });
    var wb=document.getElementById('workerBlock'), vb=document.getElementById('vdsBlock');
    if(wb) wb.style.display=mode==='worker'?'':'none';
    if(vb) vb.style.display=mode==='vds'?'':'none';
  }

  function bindModeSwitch() {
    document.querySelectorAll('.mode-btn').forEach(function(btn){
      btn.addEventListener('click', function(){ applyModeSwitch(btn.dataset.mode); });
    });
  }

  function normalizeUrl(url){
    if(!url) return '';
    url=url.trim().replace(/\/+$/,'');
    try{if(url.startsWith('http')) return new URL(url).href.replace(/\/$/,'');}catch(e){}
    return 'https://'+url;
  }

  // Возвращает базовый URL активного сервера (Worker или VDS)
  function getActiveServerUrl() {
    if(cfg.serverMode==='vds') return normalizeUrl(cfg.vdsUrl);
    return normalizeUrl(cfg.cfUrl);
  }

  // Заголовки для текущего режима
  function getServerHeaders() {
    var h = {'Content-Type':'application/json'};
    if(cfg.serverMode==='vds' && cfg.vdsApiKey) h['x-api-key'] = cfg.vdsApiKey;
    return h;
  }

  function saveSettings(){
    var btn=document.getElementById('saveSettingsBtn'); if(btn){btn.disabled=true;btn.textContent='Сохранение...';}
    // Отменяем все текущие загрузки по старым фильтрам
    ++loadCallsFromBX24._gen;
    ++loadFunnelsFromBX24._gen;

    setTimeout(function(){
      cfg.serverMode = document.querySelector('.mode-btn.active') ? (document.querySelector('.mode-btn.active').dataset.mode||'worker') : 'worker';
      cfg.cfUrl      = normalizeUrl(val('cfWorkerUrl'));
      cfg.vdsUrl     = normalizeUrl(val('vdsUrl'));
      cfg.vdsApiKey  = val('vdsApiKey');
      cfg.dsModel    = val('dsModel')||'deepseek-chat';
      cfg.whisperLang= val('whisperLang')||'ru';
      cfg.tgSaveBx   = (document.getElementById('tgSaveBx')&&document.getElementById('tgSaveBx').classList.contains('on'))?'1':'0';
      cfg.tgAlertNeg = (document.getElementById('tgAlertNeg')&&document.getElementById('tgAlertNeg').classList.contains('on'))?'1':'0';
      // Фильтры звонков по умолчанию
      var durEl=document.getElementById('settingsMinDuration');
      var durVal=durEl?parseInt(durEl.value):10;
      activeFilters.minDuration=isNaN(durVal)?0:durVal;
      // Воронки — применяем черновик
      activeFilters.funnelStages=draftFunnelStages.slice();
      saveFunnelFilter(activeFilters.funnelStages);
      // Обновляем поля если нормализация изменила URL
      var wEl=document.getElementById('cfWorkerUrl'); if(wEl&&cfg.cfUrl) wEl.value=cfg.cfUrl;
      var vEl=document.getElementById('vdsUrl');      if(vEl&&cfg.vdsUrl) vEl.value=cfg.vdsUrl;
      saveCfg();
      // Сохраняем minDuration в cfg тоже (для BX24.appOption)

      let options = {
            serverMode:cfg.serverMode, cfUrl:cfg.cfUrl, vdsUrl:cfg.vdsUrl,
            dsModel:cfg.dsModel, whisperLang:cfg.whisperLang,
            tgSaveBx:cfg.tgSaveBx, tgAlertNeg:cfg.tgAlertNeg,
            minDuration:String(activeFilters.minDuration),
            allowedUsers: JSON.stringify(cfg.allowedUsers),
            crmEntityTypes:JSON.stringify(cfg.crmEntityTypes)
      }

      try{
        BX24.callMethod('user.option.set', {
          "options": options
        },function(res){
        });
      }catch(e){
        console.log(e);
      }
      setTimeout(function(){
        if(btn){btn.disabled=false;btn.textContent='✅ Сохранено!';setTimeout(function(){btn.textContent='💾 Сохранить';},2000);}
        checkServerStatus();
        renderFunnelList();
        updateFunnelFilterLabel();
        loadCallsFromBX24();
      },200);
    },3000);
  }

  function checkServerStatus(){
    var dot=document.getElementById('serverStatusDot');
    var txt=document.getElementById('serverStatusText');
    var topDot=document.querySelector('#cfStatus .status-dot');
    var topTxt=document.getElementById('cfStatusText');

    var url=getActiveServerUrl();
    var modeName=cfg.serverMode==='vds'?'VDS':'Worker';
    if(!url){
      _setStatus(dot,'yellow','Сервер не настроен');
      _setStatus(topDot,'yellow','Сервер не настроен');
      if(txt) txt.textContent='Сервер не настроен';
      if(topTxt) topTxt.textContent='Сервер не настроен';
      return;
    }
    _setStatus(dot,'yellow','Проверяем '+modeName+'...');
    if(topTxt) topTxt.textContent='Проверяем...';

    xhrGet(url+'/health',function(err,data){
      if(err){
        _setStatus(dot,'red',modeName+' недоступен');
        if(topDot) topDot.className='status-dot red';
        if(topTxt) topTxt.textContent=modeName+' недоступен';
      } else {
        var ver='v'+(data.version||'?');
        _setStatus(dot,'green',modeName+' активен · '+ver);
        if(topDot) topDot.className='status-dot';
        if(topTxt) topTxt.textContent=modeName+' активен · '+ver;
      }
    });
  }
  // Алиас для обратной совместимости
  function checkCFStatus(){ checkServerStatus(); }

  function _setStatus(dotEl, color, msg){
    if(!dotEl) return;
    dotEl.className='status-dot'+(color==='yellow'?' yellow':color==='red'?' red':'');
    var row=dotEl.closest?dotEl.closest('.server-status-row'):null;
    var txtEl=document.getElementById('serverStatusText');
    if(txtEl) txtEl.textContent=msg;
  }

  // Кнопка «Проверить» в настройках (Worker или VDS)
  function testServer(which) {
    var raw = which==='vds' ? val('vdsUrl') : val('cfWorkerUrl');
    if(!raw){ alert('Введите URL сервера!'); return; }
    var url=normalizeUrl(raw);
    var label=which==='vds'?'VDS':'Worker';
    // Для VDS учитываем api-key
    var apiKey= which==='vds' ? val('vdsApiKey') : '';
    var xhr=new XMLHttpRequest(); xhr.open('GET',url+'/health',true); xhr.timeout=10000;
    if(apiKey) xhr.setRequestHeader('x-api-key', apiKey);
    xhr.onload=function(){
      try{
        var d=JSON.parse(xhr.responseText);
        alert('✅ '+label+' отвечает!\n'+url+'\nВерсия: '+(d.version||'?')+'\nСтатус: '+(d.status||'OK'));
      }catch(e){ alert('✅ '+label+' отвечает (HTTP '+xhr.status+')'); }
    };
    xhr.onerror=function(){ alert('❌ '+label+' недоступен:\n'+url+'\n\nПроверьте URL и что сервер запущен.'); };
    xhr.ontimeout=function(){ alert('❌ Таймаут подключения к '+label+':\n'+url); };
    xhr.send();
  }
  // Алиас для старых вызовов
  function testWorker(){ testServer('worker'); }

  function xhrGet(url,cb){
    var xhr=new XMLHttpRequest(); xhr.open('GET',url,true); xhr.timeout=10000;
    xhr.onload=function(){try{cb(null,JSON.parse(xhr.responseText));}catch(e){cb('HTTP '+xhr.status,null);}};
    xhr.onerror=function(){cb('Сетевая ошибка',null);};
    xhr.ontimeout=function(){cb('Таймаут',null);};
    xhr.send();
  }

  /* ══════════════════════════════════════════════
     ANALYTICS
  ══════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════
     ANALYTICS — v38 полная переработка
  ══════════════════════════════════════════════ */
  var anCharts = {};   // храним инстансы Chart.js для destroy при перерисовке
  var anFilters = { managers:[], dateFrom:null, dateTo:null };
  var anDraftManagers = [];

  function destroyChart(id) {
    if(anCharts[id]) { try{ anCharts[id].destroy(); }catch(e){} delete anCharts[id]; }
  }

  function initAnalyticsFilters() {
    // Синхронизируем с activeFilters (фильтр звонков) если уже задан
    if(activeFilters.dateFrom) {
      anFilters.dateFrom = activeFilters.dateFrom;
      anFilters.dateTo   = activeFilters.dateTo;
    } else {
      // По умолчанию — последние 30 дней
      var now = new Date();
      anFilters.dateTo   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      anFilters.dateFrom = new Date(anFilters.dateTo.getTime() - 29*24*3600*1000);
      anFilters.dateFrom.setHours(0,0,0,0);
    }
    anFilters.managers = activeFilters.managers.slice();
    updateAnDateLabel();

    var staffBtn = document.getElementById('anStaffBtn');
    var dateBtn  = document.getElementById('anDateBtn');
    if(staffBtn) staffBtn.addEventListener('click', openAnStaffModal);
    if(dateBtn)  dateBtn.addEventListener('click', openAnDateModal);
  }

  function updateAnDateLabel() {
    var el = document.getElementById('anDateLabel');
    if(!el) return;
    var fmt = function(d){ return d.getDate()+' '+['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'][d.getMonth()]+'.'; };
    el.textContent = fmt(anFilters.dateFrom) + ' — ' + fmt(anFilters.dateTo);
  }

  function openAnStaffModal() {
    anDraftManagers = anFilters.managers.slice();
    // Используем существующий modal сотрудников
    renderStaffModal();
    document.getElementById('staffModal').classList.add('open');
    // Переопределяем Apply для аналитики
    var applyBtn = document.getElementById('staffApplyBtn');
    if(applyBtn) {
      var newBtn = applyBtn.cloneNode(true);
      applyBtn.parentNode.replaceChild(newBtn, applyBtn);
      newBtn.addEventListener('click', function(){
        anFilters.managers = anDraftManagers.slice();
        var lbl = anFilters.managers.length ? 'Сотрудников: '+anFilters.managers.length : 'Все сотрудники';
        var btn = document.getElementById('anStaffBtn'); if(btn) btn.textContent = lbl;
        document.getElementById('staffModal').classList.remove('open');
        renderAnalytics();
      });
    }
  }

  function openAnDateModal() {
    // Заполняем поля дат
    var fromEl = document.getElementById('dateFrom');
    var toEl   = document.getElementById('dateTo');
    if(fromEl) fromEl.value = toInputDate(anFilters.dateFrom);
    if(toEl)   toEl.value   = toInputDate(anFilters.dateTo);
    document.getElementById('dateModal').classList.add('open');
    // Переопределяем кнопку Apply
    var applyBtn = document.getElementById('dateApplyBtn');
    var newBtn = applyBtn.cloneNode(true);
    applyBtn.parentNode.replaceChild(newBtn, applyBtn);
    newBtn.addEventListener('click', function(){
      var fv = document.getElementById('dateFrom').value;
      var tv = document.getElementById('dateTo').value;
      if(fv) { anFilters.dateFrom = new Date(fv); anFilters.dateFrom.setHours(0,0,0,0); }
      if(tv) { anFilters.dateTo   = new Date(tv);  anFilters.dateTo.setHours(23,59,59,0); }
      updateAnDateLabel();
      document.getElementById('dateModal').classList.remove('open');
      renderAnalytics();
    });
    // Пресеты
    document.querySelectorAll('#dateModal .preset-btn').forEach(function(btn){
      var nb = btn.cloneNode(true);
      btn.parentNode.replaceChild(nb, btn);
      nb.addEventListener('click', function(){
        var p = nb.dataset.preset;
        var now = new Date();
        var to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59);
        var fr;
        if(p==='today')     fr=new Date(to.getFullYear(),to.getMonth(),to.getDate(),0,0,0);
        else if(p==='yesterday'){ to=new Date(to.getTime()-86400000); to.setHours(23,59,59); fr=new Date(to.getFullYear(),to.getMonth(),to.getDate(),0,0,0); }
        else if(p==='7days') fr=new Date(to.getTime()-6*86400000);
        else if(p==='30days')fr=new Date(to.getTime()-29*86400000);
        else if(p==='month') fr=new Date(now.getFullYear(),now.getMonth(),1);
        else { fr=new Date(2020,0,1); }
        if(fr) fr.setHours(0,0,0,0);
        anFilters.dateFrom=fr; anFilters.dateTo=to;
        updateAnDateLabel();
        document.querySelectorAll('#dateModal .preset-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.preset===p); });
        document.getElementById('dateModal').classList.remove('open');
        renderAnalytics();
      });
    });
  }

  function getAnCalls() {
    return allLoadedCalls.filter(function(c){
      if(anFilters.managers.length && anFilters.managers.indexOf(c.userId)===-1) return false;
      if(anFilters.dateFrom && c.ts < anFilters.dateFrom.getTime()) return false;
      if(anFilters.dateTo   && c.ts > anFilters.dateTo.getTime())   return false;
      return true;
    });
  }

  function renderAnalytics(){
    if(document.getElementById('page-analytics').style.display==='none') return;

    // Инициализируем фильтры при первом вызове
    if(!anFilters.dateFrom) initAnalyticsFilters();

    var all = getAnCalls();
    var analyzed = all.filter(function(c){ return c.analysis; });

    renderAnKpi(all, analyzed);
    renderAnDynamics(all);
    renderAnHours(all);
    renderAnSkills(analyzed);
    renderAnTone(analyzed);
    renderAnTopics(analyzed);
    renderAnStaffRating(analyzed);
    renderAnCompliance(analyzed);
    renderAnSmartTags(analyzed);
    renderAnCrm(all);
    renderAnDirection(all);
    renderAnDuration(all);
    renderAnHeatmap(all);
    renderAnRecentAnalyses(analyzed);
    renderAnNeedAttention(analyzed);
    renderAnRecentCalls(all);
  }

  /* ── KPI ── */
  function renderAnKpi(all, analyzed) {
    setText('anTotal', all.length);

    var scores = analyzed.map(function(c){ return calcScore(c.analysis)||0; }).filter(function(s){ return s>0; });
    var avgScore = scores.length ? Math.round(scores.reduce(function(a,b){return a+b;},0)/scores.length) : null;
    setText('anAvgScore', avgScore!=null ? avgScore : '—');
    setText('anAnalyzedCount', scores.length ? scores.length+' анализов' : '');

    var missed = all.filter(function(c){ return c.callType==='3'||c.callType==='6'; }).length;
    // Пропущенные = звонки без записи входящие (тип 2/3) ИЛИ явно пропущенные
    // В BX24: CALL_TYPE=3 — входящий без ответа
    var missedReal = all.filter(function(c){ return c.callType==='3'; }).length;
    setText('anMissed', missedReal);
    setText('anMissedPct', all.length ? Math.round(missedReal/all.length*100)+'%' : '');

    var crmBound = all.filter(function(c){ return c._crmResolved && (c._crmResolved.type==='LEAD'||c._crmResolved.type==='DEAL'); }).length;
    setText('anCrmPct', all.length ? Math.round(crmBound/all.length*100)+'%' : '—');

    var durs = all.filter(function(c){ return c._durationSec>0; }).map(function(c){ return c._durationSec; });
    var avgSec = durs.length ? Math.round(durs.reduce(function(a,b){return a+b;},0)/durs.length) : 0;
    setText('anAvgDur', avgSec ? Math.floor(avgSec/60)+' мин '+pad(avgSec%60)+' сек' : '—');
  }

  /* ── Динамика звонков (линейный график) ── */
  function renderAnDynamics(all) {
    destroyChart('dynamics');
    var canvas = document.getElementById('anDynamicsChart'); if(!canvas) return;

    // Группируем по датам
    var dateMap = {};
    all.forEach(function(c){
      var d = new Date(c.ts);
      var key = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
      if(!dateMap[key]) dateMap[key]={in:0,out:0,missed:0};
      if(c.callType==='1') dateMap[key].out++;
      else if(c.callType==='2') dateMap[key].in++;
      else if(c.callType==='3') { dateMap[key].in++; dateMap[key].missed++; }
    });

    var keys = Object.keys(dateMap).sort();
    if(!keys.length) { canvas.parentElement.innerHTML+='<div class="an-empty">Нет данных</div>'; return; }

    var labels = keys.map(function(k){
      var p=k.split('-');
      return p[2]+' '+['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'][parseInt(p[1])-1]+'.';
    });

    anCharts.dynamics = new Chart(canvas, {
      type:'line',
      data:{
        labels:labels,
        datasets:[
          {label:'Входящие', data:keys.map(function(k){return dateMap[k].in;}), borderColor:'#818cf8', backgroundColor:'rgba(129,140,248,0.08)', tension:0.4, pointRadius:3},
          {label:'Исходящие', data:keys.map(function(k){return dateMap[k].out;}), borderColor:'#a78bfa', backgroundColor:'rgba(167,139,250,0.08)', tension:0.4, pointRadius:3},
          {label:'Пропущенные', data:keys.map(function(k){return dateMap[k].missed;}), borderColor:'#f87171', backgroundColor:'rgba(248,113,113,0.08)', tension:0.4, pointRadius:3}
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:true, aspectRatio:2.5,
        interaction:{mode:'index', intersect:false},
        plugins:{legend:{position:'top', labels:{boxWidth:10, font:{size:11}}}, tooltip:{callbacks:{title:function(items){return items[0].label;}}}},
        scales:{x:{grid:{display:false}, ticks:{font:{size:10}}}, y:{beginAtZero:true, ticks:{stepSize:1, font:{size:10}}, grid:{color:'rgba(0,0,0,0.05)'}}}
      }
    });
  }

  /* ── Активность по часам (топ-5 часов, хронологический порядок) ── */
  function renderAnHours(all) {
    destroyChart('hours');
    var canvas = document.getElementById('anHoursChart'); if(!canvas) return;

    var hourMap = {};
    all.forEach(function(c){
      var h = new Date(c.ts).getHours();
      hourMap[h] = (hourMap[h]||0)+1;
    });

    // Топ-5 часов
    var sorted = Object.keys(hourMap).sort(function(a,b){ return hourMap[b]-hourMap[a]; }).slice(0,5);
    // Возвращаем в хронологический порядок
    sorted.sort(function(a,b){ return parseInt(a)-parseInt(b); });

    var labels = sorted.map(function(h){ return pad(h)+':00'; });
    var data   = sorted.map(function(h){ return hourMap[h]; });

    anCharts.hours = new Chart(canvas, {
      type:'bar',
      data:{
        labels:labels,
        datasets:[{data:data, backgroundColor:'#818cf8', borderRadius:6, borderSkipped:false}]
      },
      options:{
        responsive:true, maintainAspectRatio:true, aspectRatio:2.5,
        plugins:{legend:{display:false}, tooltip:{callbacks:{label:function(ctx){ return ctx.parsed.y+' звонков'; }}}},
        scales:{x:{grid:{display:false}, ticks:{font:{size:11}}}, y:{beginAtZero:true, ticks:{stepSize:1, font:{size:10}}, grid:{color:'rgba(0,0,0,0.05)'}}}
      }
    });
  }

  /* ── Матрица навыков (радарная диаграмма из секций скрипт-чека) ── */
  function renderAnSkills(analyzed) {
    destroyChart('skills');
    var canvas = document.getElementById('anSkillsChart'); if(!canvas) return;

    // Собираем навыки из секций анализа
    var skillMap = {};
    analyzed.forEach(function(c){
      var a = c.analysis;
      // Из секций script-check
      if(a.scriptChecks) {
        Object.values(a.scriptChecks).forEach(function(chk){
          if(chk&&chk.data&&chk.data.sections) {
            chk.data.sections.forEach(function(sec){
              if(!skillMap[sec.name]) skillMap[sec.name]={sum:0,cnt:0};
              skillMap[sec.name].sum += sec.score||0;
              skillMap[sec.name].cnt++;
            });
          }
        });
      }
      // Из обычного анализа
      (a.sections||[]).forEach(function(sec){
        if(!skillMap[sec.name]) skillMap[sec.name]={sum:0,cnt:0};
        skillMap[sec.name].sum += sec.score||0;
        skillMap[sec.name].cnt++;
      });
    });

    var skills = Object.keys(skillMap).slice(0,6);
    if(skills.length < 3) {
      canvas.parentElement.innerHTML += '<div class="an-empty" style="margin-top:20px">Проведите анализ по скрипту для матрицы навыков</div>';
      return;
    }

    var vals = skills.map(function(k){ return Math.round(skillMap[k].sum/skillMap[k].cnt); });

    anCharts.skills = new Chart(canvas, {
      type:'radar',
      data:{
        labels: skills.map(function(s){ return s.length>12 ? s.slice(0,12)+'…' : s; }),
        datasets:[{
          data:vals, label:'Навыки',
          backgroundColor:'rgba(129,140,248,0.15)',
          borderColor:'#6366f1', borderWidth:2,
          pointBackgroundColor:'#6366f1', pointRadius:4
        }]
      },
      options:{
        responsive:false,
        plugins:{legend:{display:false}},
        scales:{r:{beginAtZero:true, max:100, ticks:{stepSize:25, font:{size:9}}, pointLabels:{font:{size:10}}, grid:{color:'rgba(0,0,0,0.08)'}}}
      }
    });
  }

  /* ── Тональность (дoughnut) ── */
  function renderAnTone(analyzed) {
    destroyChart('tone');
    var canvas = document.getElementById('anToneChart'); if(!canvas) return;
    var pos = analyzed.filter(function(c){return c.analysis.sentiment==='positive';}).length;
    var neg = analyzed.filter(function(c){return c.analysis.sentiment==='negative';}).length;
    var neu = analyzed.length - pos - neg;

    var legendEl = document.getElementById('anToneLegend');
    if(!analyzed.length) {
      if(legendEl) legendEl.innerHTML='<div class="an-empty">Нет данных</div>';
      return;
    }

    anCharts.tone = new Chart(canvas, {
      type:'doughnut',
      data:{
        labels:['Позитивно','Нейтрально','Негативно'],
        datasets:[{data:[pos,neu,neg], backgroundColor:['#4ade80','#fbbf24','#f87171'], borderWidth:0, hoverOffset:4}]
      },
      options:{
        responsive:false, cutout:'65%',
        plugins:{legend:{display:false}, tooltip:{callbacks:{label:function(ctx){ return ctx.label+': '+ctx.parsed+' ('+Math.round(ctx.parsed/analyzed.length*100)+'%)'; }}}}
      }
    });

    if(legendEl) legendEl.innerHTML=[
      {l:'Позитивно',c:'#4ade80',v:pos},{l:'Нейтрально',c:'#fbbf24',v:neu},{l:'Негативно',c:'#f87171',v:neg}
    ].map(function(x){
      return '<span class="an-legend-item"><span class="an-legend-dot" style="background:'+x.c+'"></span>'+x.l+'</span>';
    }).join('');
  }

  /* ── Топ тематик ── */
  function renderAnTopics(analyzed) {
    var el = document.getElementById('anTopics'); if(!el) return;
    var tc={};
    analyzed.forEach(function(c){(c.analysis.topics||[]).forEach(function(t){tc[t]=(tc[t]||0)+1;});});
    var sorted = Object.keys(tc).sort(function(a,b){return tc[b]-tc[a];}).slice(0,8);
    var max = sorted.length ? tc[sorted[0]] : 1;
    el.innerHTML = sorted.length ? sorted.map(function(t){
      var pct = Math.round(tc[t]/max*100);
      return '<div class="an-topic-row">'+
        '<span class="an-topic-arrow">›</span>'+
        '<div class="an-topic-info">'+
          '<div class="an-topic-name">'+esc(t)+'</div>'+
          '<div class="an-topic-bar"><div style="width:'+pct+'%;background:#4ade80;height:3px;border-radius:2px"></div></div>'+
        '</div>'+
        '<span class="an-topic-cnt">'+tc[t]+'</span>'+
      '</div>';
    }).join('') : '<div class="an-empty">Нет данных</div>';
  }

  /* ── Рейтинг сотрудников (топ 5) ── */
  function renderAnStaffRating(analyzed) {
    var el = document.getElementById('anStaffRating'); if(!el) return;
    var mgrs={};
    analyzed.forEach(function(c){
      var id=c.userId;
      if(!mgrs[id]) mgrs[id]={name:c.manager,calls:0,totalScore:0,skills:{}};
      mgrs[id].calls++;
      // Общее качество звонка (calcScore учитывает и скрипт, и AI-анализ)
      mgrs[id].totalScore += calcScore(c.analysis)||0;
      // Навыки: приоритет — секции из scriptChecks, запасной — из AI-анализа
      var addedSkills = false;
      var checks = c.analysis.scriptChecks||{};
      Object.values(checks).forEach(function(chk){
        if(!chk||!chk.data) return;
        (chk.data.sections||[]).forEach(function(sec){
          if(!mgrs[id].skills[sec.name]) mgrs[id].skills[sec.name]={sum:0,cnt:0};
          mgrs[id].skills[sec.name].sum += sec.score||0;
          mgrs[id].skills[sec.name].cnt++;
          addedSkills=true;
        });
      });
      // Если нет скрипт-чека — берём секции из AI-анализа
      if(!addedSkills) {
        (c.analysis.sections||[]).forEach(function(sec){
          if(!mgrs[id].skills[sec.name]) mgrs[id].skills[sec.name]={sum:0,cnt:0};
          mgrs[id].skills[sec.name].sum+=sec.score||0;
          mgrs[id].skills[sec.name].cnt++;
        });
      }
    });

    var list = Object.values(mgrs).sort(function(a,b){ return (b.totalScore/b.calls)-(a.totalScore/a.calls); }).slice(0,5);
    if(!list.length) { el.innerHTML='<div class="an-empty">Нет данных</div>'; return; }

    el.innerHTML = list.map(function(m, idx){
      var score = Math.round(m.totalScore/m.calls);
      var scoreCls = score>=80?'#3d7a56':score>=50?'#8a6a2a':'#a04040';
      var skillTags = Object.keys(m.skills).slice(0,3).map(function(sk){
        var s=Math.round(m.skills[sk].sum/m.skills[sk].cnt);
        var c=s>=80?'#3d7a56':s>=50?'#8a6a2a':'#a04040';
        return '<span class="an-skill-tag" style="color:'+c+'">'+esc(sk.length>14?sk.slice(0,14)+'…':sk)+' '+s+'</span>';
      }).join('');
      return '<div class="an-staff-row">'+
        '<div class="an-staff-rank">'+(idx+1)+'</div>'+
        '<div class="an-staff-avatar">'+m.name.charAt(0).toUpperCase()+'</div>'+
        '<div class="an-staff-info">'+
          '<div class="an-staff-name">'+esc(m.name)+'</div>'+
          '<div style="font-size:11px;color:var(--muted2)">'+m.calls+' анализов</div>'+
          '<div style="margin-top:4px">'+skillTags+'</div>'+
        '</div>'+
        '<div class="an-staff-score" style="color:'+scoreCls+'">'+score+'</div>'+
      '</div>';
    }).join('');
  }

  /* ── Соответствие стандартам — только из проверок по скрипту ── */
  function renderAnCompliance(analyzed) {
    var el = document.getElementById('anCompliance'); if(!el) return;

    // Собираем данные только из scriptChecks (проверки по скрипту)
    var rules={};
    analyzed.forEach(function(c){
      var checks = c.analysis.scriptChecks||{};
      Object.values(checks).forEach(function(chk){
        if(!chk||!chk.data) return;
        // Секции скрипт-чека
        (chk.data.sections||[]).forEach(function(sec){
          if(!rules[sec.name]) rules[sec.name]={sum:0,cnt:0};
          rules[sec.name].sum += sec.score||0;
          rules[sec.name].cnt++;
        });
        // compliance-флаги из скрипт-чека
        (chk.data.compliance||[]).forEach(function(item){
          var key = item.label||item.name||'';
          if(!key) return;
          if(!rules[key]) rules[key]={ok:0,total:0,isFlag:true};
          rules[key].total=(rules[key].total||0)+1;
          if(item.ok) rules[key].ok=(rules[key].ok||0)+1;
        });
      });
    });

    var keys = Object.keys(rules);
    if(!keys.length) { el.innerHTML='<div class="an-empty">Проведите проверку по скрипту для этих данных</div>'; return; }

    el.innerHTML = keys.map(function(k){
      var r=rules[k];
      var pct = r.isFlag
        ? Math.round((r.ok||0)/(r.total||1)*100)
        : Math.round((r.sum||0)/(r.cnt||1));
      var color=pct>=80?'#3d7a56':pct>=50?'#8a6a2a':'#a04040';
      var bgColor=pct>=80?'#4ade80':pct>=50?'#fbbf24':'#f87171';
      return '<div class="an-compliance-row">'+
        '<div class="an-comp-label">'+esc(k.length>28?k.slice(0,28)+'…':k)+'</div>'+
        '<div class="an-comp-bar-wrap">'+
          '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">'+
            '<div style="width:'+pct+'%;height:100%;background:'+bgColor+';border-radius:3px"></div>'+
          '</div>'+
        '</div>'+
        '<div class="an-comp-pct" style="color:'+color+'">'+pct+'%</div>'+
      '</div>';
    }).join('');
  }

  /* ── Smart-теги ── */
  function renderAnSmartTags(analyzed) {
    var el = document.getElementById('anSmartTags'); if(!el) return;
    var tc={};
    analyzed.forEach(function(c){(c.analysis.topics||[]).forEach(function(t){tc[t]=(tc[t]||0)+1;});});
    var sorted=Object.keys(tc).sort(function(a,b){return tc[b]-tc[a];});
    if(!sorted.length){ el.innerHTML='<div class="an-empty">Нет данных</div>'; return; }
    el.innerHTML = sorted.map(function(t){
      var size=Math.max(11,Math.min(15,11+tc[t]));
      return '<span class="an-tag" style="font-size:'+size+'px">'+esc(t)+' <sup>'+tc[t]+'</sup></span>';
    }).join('');
  }

  /* ── Привязка к CRM (doughnut) ── */
  function renderAnCrm(all) {
    destroyChart('crm');
    var canvas = document.getElementById('anCrmChart'); if(!canvas) return;
    var counts={LEAD:0,CONTACT:0,DEAL:0,COMPANY:0,none:0};
    all.forEach(function(c){
      var t=c._crmResolved?c._crmResolved.type:null;
      if(t==='LEAD') counts.LEAD++;
      else if(t==='CONTACT') counts.CONTACT++;
      else if(t==='DEAL') counts.DEAL++;
      else if(t==='COMPANY') counts.COMPANY++;
      else counts.none++;
    });
    var labels=['Лид','Контакт','Сделка','Компания','Без CRM'];
    var data=[counts.LEAD,counts.CONTACT,counts.DEAL,counts.COMPANY,counts.none];
    var colors=['#fb923c','#60a5fa','#4ade80','#c084fc','#d1d5db'];

    var legendEl=document.getElementById('anCrmLegend');
    if(!all.length){ if(legendEl) legendEl.innerHTML='<div class="an-empty">Нет данных</div>'; return; }

    anCharts.crm = new Chart(canvas,{
      type:'doughnut',
      data:{labels:labels,datasets:[{data:data,backgroundColor:colors,borderWidth:0,hoverOffset:4}]},
      options:{responsive:false,cutout:'60%',plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.label+': '+ctx.parsed;}}}}}
    });
    if(legendEl) legendEl.innerHTML=labels.map(function(l,i){
      if(!data[i]) return '';
      return '<span class="an-legend-item"><span class="an-legend-dot" style="background:'+colors[i]+'"></span>'+l+'</span>';
    }).join('');
  }

  /* ── Направление (doughnut) ── */
  function renderAnDirection(all) {
    destroyChart('dir');
    var canvas=document.getElementById('anDirChart'); if(!canvas) return;
    var inc=all.filter(function(c){return c.callType==='2'||c.callType==='3';}).length;
    var out=all.filter(function(c){return c.callType==='1';}).length;
    var mis=all.filter(function(c){return c.callType==='3';}).length;

    var legendEl=document.getElementById('anDirLegend');
    anCharts.dir = new Chart(canvas,{
      type:'doughnut',
      data:{
        labels:['Входящие','Исходящие','Пропущенные'],
        datasets:[{data:[inc,out,mis],backgroundColor:['#60a5fa','#c084fc','#f87171'],borderWidth:0,hoverOffset:4}]
      },
      options:{responsive:false,cutout:'60%',plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.label+': '+ctx.parsed;}}}}}
    });
    if(legendEl) legendEl.innerHTML=[{l:'Входящие',c:'#60a5fa'},{l:'Исходящие',c:'#c084fc'},{l:'Пропущенные',c:'#f87171'}].map(function(x){
      return '<span class="an-legend-item"><span class="an-legend-dot" style="background:'+x.c+'"></span>'+x.l+'</span>';
    }).join('');
  }

  /* ── Длительность звонков (bar) ── */
  function renderAnDuration(all) {
    destroyChart('dur');
    var canvas=document.getElementById('anDurChart'); if(!canvas) return;
    var bins={'0-30с':0,'30-60с':0,'1-3м':0,'3-5м':0,'5-10м':0,'10м+':0};
    all.forEach(function(c){
      var s=c._durationSec||0;
      if(s<30) bins['0-30с']++;
      else if(s<60) bins['30-60с']++;
      else if(s<180) bins['1-3м']++;
      else if(s<300) bins['3-5м']++;
      else if(s<600) bins['5-10м']++;
      else bins['10м+']++;
    });
    anCharts.dur = new Chart(canvas,{
      type:'bar',
      data:{
        labels:Object.keys(bins),
        datasets:[{data:Object.values(bins),backgroundColor:'#fb923c',borderRadius:6,borderSkipped:false}]
      },
      options:{
        responsive:true, maintainAspectRatio:true, aspectRatio:1.8,
        plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.y+' звонков';}}}},
        scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{beginAtZero:true,ticks:{stepSize:1,font:{size:10}},grid:{color:'rgba(0,0,0,0.05)'}}}
      }
    });
  }

  /* ── Тепловая карта ── */
  function renderAnHeatmap(all) {
    var el=document.getElementById('anHeatmap'); if(!el) return;
    var days=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    var hours=[0,3,6,9,12,15,18,21];
    var grid={};
    all.forEach(function(c){
      var d=new Date(c.ts);
      var dow=(d.getDay()+6)%7; // 0=Пн
      var hBucket=Math.floor(d.getHours()/3)*3;
      var key=dow+':'+hBucket;
      grid[key]=(grid[key]||0)+1;
    });
    var maxVal=Math.max(1,Math.max.apply(null,Object.values(grid)));

    var html='<div class="hm-grid">'+
      '<div class="hm-row"><div class="hm-label"></div>'+hours.map(function(h){return '<div class="hm-hlabel">'+pad(h)+':00</div>';}).join('')+'</div>'+
      days.map(function(day,di){
        return '<div class="hm-row">'+
          '<div class="hm-label">'+day+'</div>'+
          hours.map(function(h){
            var cnt=grid[di+':'+h]||0;
            var alpha=cnt?Math.max(0.1,cnt/maxVal):0;
            var bg=cnt?'rgba(99,102,241,'+alpha.toFixed(2)+')':'var(--surface2)';
            return '<div class="hm-cell" style="background:'+bg+'" title="'+day+' '+pad(h)+':00 — '+cnt+' зв."></div>';
          }).join('')+
        '</div>';
      }).join('')+
    '</div>';
    el.innerHTML=html;
  }

  /* ── Последние анализы ── */
  function renderAnRecentAnalyses(analyzed) {
    var el=document.getElementById('anRecentAnalyses'); if(!el) return;
    var sorted=analyzed.slice().sort(function(a,b){return b.ts-a.ts;}).slice(0,5);
    if(!sorted.length){ el.innerHTML='<div class="an-empty">Нет анализов</div>'; return; }
    el.innerHTML=sorted.map(function(c){
      var score=calcScore(c.analysis);
      var scoreColor=score>=80?'#3d7a56':score>=50?'#8a6a2a':'#a04040';
      var sections=(c.analysis.sections||[]).slice(0,3).map(function(s){
        var sc=s.score; var sc2=sc>=80?'#3d7a56':sc>=50?'#8a6a2a':'#a04040';
        return '<span class="an-sec-tag" style="color:'+sc2+'">'+esc(s.name.length>16?s.name.slice(0,16)+'…':s.name)+' '+sc+'</span>';
      }).join('');
      var topics=(c.analysis.topics||[]).slice(0,3).map(function(t){return '<span class="an-small-tag">'+esc(t)+'</span>';}).join('');
      return '<div class="an-feed-item" onclick="App.openCallModal(\''+c.id+'\',\'overview\')" style="cursor:pointer">'+
        '<div class="an-feed-header">'+
          '<span class="an-feed-phone">'+esc(c.contact||c.phone)+'</span>'+
          '<span class="an-feed-score" style="color:'+scoreColor+'">'+score+'</span>'+
        '</div>'+
        '<div class="an-feed-resume">'+esc((c.analysis.resume||'').slice(0,80))+'</div>'+
        sections+
        '<div style="margin-top:4px">'+topics+'</div>'+
        '<div class="an-feed-meta">'+esc(c.manager)+' &nbsp; '+fmtDate(c.ts)+' '+fmtTime(c.ts)+'</div>'+
      '</div>';
    }).join('');
  }

  /* ── Требуют внимания (оценка < 50) ── */
  function renderAnNeedAttention(analyzed) {
    var el=document.getElementById('anNeedAttention'); if(!el) return;
    var bad=analyzed.filter(function(c){ return (calcScore(c.analysis)||0)<50; }).sort(function(a,b){return b.ts-a.ts;});
    if(!bad.length){
      el.innerHTML='<div style="text-align:center;padding:30px 0">'+
        '<div style="font-size:32px;margin-bottom:8px">😊</div>'+
        '<div style="font-weight:600;color:var(--text)">Отличная работа!</div>'+
        '<div style="font-size:12px;color:var(--muted2);margin-top:4px">ПРОБЛЕМНЫХ ЗВОНКОВ НЕТ</div>'+
      '</div>';
      return;
    }
    el.innerHTML=bad.slice(0,5).map(function(c){
      var score=calcScore(c.analysis);
      return '<div class="an-feed-item" onclick="App.openCallModal(\''+c.id+'\',\'overview\')" style="cursor:pointer">'+
        '<div class="an-feed-header">'+
          '<span class="an-feed-phone">'+esc(c.contact||c.phone)+'</span>'+
          '<span class="an-feed-score" style="color:#a04040">'+score+'</span>'+
        '</div>'+
        '<div class="an-feed-resume">'+esc((c.analysis.resume||'').slice(0,80))+'</div>'+
        '<div class="an-feed-meta">'+esc(c.manager)+' &nbsp; '+fmtDate(c.ts)+' '+fmtTime(c.ts)+'</div>'+
      '</div>';
    }).join('');
  }

  /* ── Последние звонки ── */
  function renderAnRecentCalls(all) {
    var el=document.getElementById('anRecentCalls'); if(!el) return;
    var sorted=all.slice().sort(function(a,b){return b.ts-a.ts;}).slice(0,10);
    if(!sorted.length){ el.innerHTML='<div class="an-empty">Нет звонков</div>'; return; }
    el.innerHTML=sorted.map(function(c){
      var missed=c.callType==='3';
      var isOut=c.callType==='1';
      var dotColor=missed?'#f87171':isOut?'#c084fc':'#60a5fa';
      return '<div class="an-call-row" onclick="App.openCallModal(\''+c.id+'\',\'overview\')" style="cursor:pointer">'+
        '<span class="an-call-dot" style="background:'+dotColor+'"></span>'+
        '<div class="an-call-info">'+
          '<div class="an-call-phone">'+esc(c.contact||c.phone)+'</div>'+
          '<div class="an-call-meta">'+esc(c.manager)+'</div>'+
        '</div>'+
        '<div class="an-call-right">'+
          '<div class="an-call-time">'+fmtTime(c.ts)+'</div>'+
          (missed?'<div class="an-call-missed">ПРОПУЩЕН</div>':'<div class="an-call-dur">'+c.duration+'</div>')+
        '</div>'+
      '</div>';
    }).join('');
  }

  /* ══════════════════════════════════════════════
     UTILS
  ══════════════════════════════════════════════ */
  function saveCommentNow(id){
    var c=allLoadedCalls.find(function(x){return x.id===id;}); if(!c||!c.analysis) return;
    try{BX24.callMethod('telephony.externalcall.finish',{CALL_ID:id,COMMENT:buildComment(c.analysis)},function(){alert('✅ Сохранено в Bitrix24!');});}catch(e){alert('Ошибка сохранения: '+e);}
  }
  function buildComment(a){
    var lbl={positive:'Позитивная 😊',neutral:'Нейтральная 😐',negative:'Негативная 😡'};
    return ['🎙️ CallMind AI','Тональность: '+(lbl[a.sentiment]||a.sentiment)+' ('+a.pos+'%/'+a.neu+'%/'+a.neg+'%)',
      'Темы: '+(a.topics||[]).join(', '),a.resume?'Резюме: '+a.resume:'']
      .concat((a.keyPoints||[]).map(function(kp){return kp.icon+' '+kp.label+': '+kp.text;})).join('\n');
  }

  function fmtDate(ts){if(!ts||+ts<=0)return'—';var d=new Date(ts);return pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+d.getFullYear();}
  function fmtTime(ts){if(!ts||+ts<=0)return'—';var d=new Date(ts);return pad(d.getHours())+':'+pad(d.getMinutes());}
  function formatDur(sec){if(!sec||sec<=0)return'—';return Math.floor(sec/60)+':'+pad(sec%60);}
  function toInputDate(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
  function pad(n){return String(n).padStart(2,'0');}
  function setText(id,v){var el=document.getElementById(id);if(el)el.textContent=v;}
  function val(id){var el=document.getElementById(id);return el?el.value.trim():'';}
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  document.addEventListener('DOMContentLoaded', init);

  return { showPage, saveSettings, testWorker, testServer, closeModal, analyzeCall, saveCommentNow, openCallModal };
})();
