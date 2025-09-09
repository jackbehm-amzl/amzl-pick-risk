// ==UserScript==
// @name         AMZL Pick Risk
// @namespace    amzl.pick.risk
// @version      4.0
// @author       jackbehm, tugglest
// @description  Recreation of tugglest's Excel Pick Risk 3.0 tool
// @match        https://logistics.amazon.com/station/dashboard/pick*
// @match        https://ui.*.last-mile.amazon.dev/*
// @match        https://*.last-mile.amazon.dev/*
// @updateURL    https://raw.githubusercontent.com/jackbehm-amzl/amzl-pick-risk/main/AMZL%20Pick%20Risk-4.0.user.js
// @downloadURL  https://raw.githubusercontent.com/jackbehm-amzl/amzl-pick-risk/main/AMZL%20Pick%20Risk-4.0.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function(){
  'use strict';

  const IS_TOP = window.top === window.self;
  const ON_PICK_TOP = IS_TOP &&
    /\/station\/dashboard\/pick\b/.test(location.pathname + location.hash) &&
    /logistics\.amazon\.com$/.test(location.host);

  // ---------- Config ----------
  const CFG_KEY = 'amzl.pickrisk.table.config.v6';
  const CFG = {
    avgPLMin: 13.5,
    shiftEndHHmm: '11:50',                 // display only; TIME LEFT uses Stage-By
    thresholds: { safe: 1.35, low: 1.25, high: 1.00 }, // Safe / Low / High / Proj Miss
    showSafe: false                        // NEW: toggle Safe rows
  };
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch {}
  function persist(){ try{ localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); }catch{} }

  // ---------- Cross-frame CSV capture ----------
  (function installBlobSniffer(){
    if (window.__amzl_csv_sniffer_installed__) return;
    window.__amzl_csv_sniffer_installed__ = true;

    const WURL = window.URL || window.webkitURL;
    if (!WURL) return;

    const origCreate = WURL.createObjectURL.bind(WURL);
    const origBlob   = Response.prototype.blob;

    function looksLikeCSV(b){ const t=(b&&b.type||'').toLowerCase(); return t.includes('text/csv')||t.includes('csv'); }
    function send(text){ try{ window.top.postMessage({__amzl_csv_capture__:true, text}, '*'); }catch{} }

    WURL.createObjectURL = function(blob){ try{ if (blob && looksLikeCSV(blob)) blob.text().then(send).catch(()=>{});}catch{} return origCreate(blob); };
    Response.prototype.blob = function(){ return origBlob.call(this).then(b=>{ try{ if (looksLikeCSV(b)) b.text().then(send).catch(()=>{});}catch{} return b; }); };
  })();

  // ---------- CSV ----------
  function parseCSV(text){
    const rows=[]; let i=0,cell='',row=[],q=false;
    while(i<text.length){ const c=text[i++]; if(q){ if(c==='"'){ if(text[i]==='"'){cell+='"';i++;} else q=false;} else cell+=c; }
      else{ if(c==='"') q=true; else if(c===','){row.push(cell);cell='';} else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';} else if(c!=='\r'){cell+=c;} } }
    row.push(cell); rows.push(row);
    if(rows.length && rows[rows.length-1].length===1 && rows[rows.length-1][0]==='') rows.pop();
    return rows;
  }

  // ---------- Time ----------
  function parseHHmm(str){ const m=String(str||'').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/); if(!m) return null; const h=+m[1],mi=+m[2],s=+(m[3]||0); if(h>=0&&h<24&&mi>=0&&mi<60&&s>=0&&s<60) return {h,mi,s}; return null; }
  function todayWithHMS(h, mi, s){ const d=new Date(); d.setSeconds(0,0); d.setHours(h,mi,s||0,0); return d; }
  function parseMaybeTime(s){ const d=new Date(s); if(!isNaN(d)) return d; const hm=parseHHmm(s); return hm?todayWithHMS(hm.h,hm.mi,hm.s):null; }
  function minsFloat(a,b){ return Math.max(0, (b-a)/60000); }
  function toHMS(mins){ const total=Math.max(0, Math.round(mins*60)); const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), s=total%60; return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }

  // ---------- Compute (Excel parity + fixed risk basis) ----------
  function computeFromCSV(rows, header){
    const H = header.map(h => (h||'').toString().trim().toLowerCase());
    function findCol(names){
      for(const n of names){ const j=H.indexOf(n); if(j!==-1) return j; }
      for(let j=0;j<H.length;j++) for(const n of names){ if(H[j].includes(n)) return j; }
      return -1;
    }
    const idx = {
      stageBy:  findCol(['stage by time','stage by','stageby','stage_time','stage time']),
      status:   findCol(['status','state']),
      assoc:    findCol(['associate','employee','picker','user']),
      plcode:   findCol(['picklist code','picklist','pl code'])
    };

    const now = new Date();

    // Normalize rows (picklist only)
    const norm = [];
    for(const r of rows){
      const plcode = idx.plcode>=0 ? String(r[idx.plcode]||'').trim() : '';
      if(!plcode) continue;
      const stage  = idx.stageBy>=0 ? parseMaybeTime(r[idx.stageBy]) : null;
      if(!stage) continue;
      const status = (idx.status>=0 ? r[idx.status] : '').toString().trim().toLowerCase();
      const assocRaw = (idx.assoc>=0 ? r[idx.assoc] : '').toString().trim();
      const assocs = assocRaw ? assocRaw.split(/[;,]/).map(x=>x.trim()).filter(Boolean) : [];
      let state='other';
      if (/^picked\b/.test(status)) state='picked';
      else if (/(^|\s)in\s*progress\b|picking/.test(status)) state='inprog';
      else if (/(not\s*assigned|unassigned)/.test(status)) state='unassigned';
      norm.push({stage, state, assocs});
    }

    // Global Active HC
    const activeHCSet = new Set();
    for(const r of norm) if(r.state==='inprog' && r.assocs.length) for(const a of r.assocs) activeHCSet.add(a);
    const activeHCGlobal = activeHCSet.size || norm.filter(r=>r.state==='inprog').length;

    // Buckets by Stage-By
    const map = new Map();
    for(const r of norm){
      const key=r.stage.toISOString();
      if(!map.has(key)) map.set(key,{stage:r.stage,total:0,picked:0,inProg:0,unassigned:0});
      const b=map.get(key);
      b.total++;
      if(r.state==='picked') b.picked++;
      else if(r.state==='inprog') b.inProg++;
      else if(r.state==='unassigned') b.unassigned++;
    }
    const buckets = Array.from(map.values()).sort((a,b)=>a.stage-b.stage);

    const avg = CFG.avgPLMin, t = CFG.thresholds, sf = t.safe;
    let cumNeed = 0;
    const computed = [];
    for(const b of buckets){
      const isPast = b.stage <= now;
      const needThis = b.unassigned + b.inProg;
      cumNeed += needThis;

      const tlMin = minsFloat(now, b.stage);                 // time to Stage-By
      const capacity = tlMin>0 ? activeHCGlobal * (tlMin/avg) : 0;
      const hcNeed   = tlMin>0 ? Math.ceil(cumNeed * (avg/tlMin) * sf) : 0;

      // >>> Excel-parity risk basis: derive PL Need from hcNeed and compare capacity to that
      // hcNeed ≈ ceil( PLneed * (avg/tlMin) * 1.35 )  =>  PLneed ≈ hcNeed * (tlMin/avg) / 1.35
      const plNeedForRisk = tlMin > 0
        ? Math.max(1, Math.round((hcNeed * tlMin) / (avg * sf)))
        : cumNeed;

      const ratio = plNeedForRisk > 0 ? (capacity / plNeedForRisk) : Infinity;

      const risk = isPast ? '' :
        (!isFinite(ratio) ? 'Safe' :
          ratio >= t.safe ? 'Safe' :
          ratio >= t.low  ? 'Low Risk' :
          ratio >= t.high ? 'High Risk' : 'Proj Miss');

      computed.push({
        stage:b.stage, isPast,
        totals:{ total:b.total, picked:b.picked, inProg:b.inProg, unassigned:b.unassigned },
        listsRemaining: Math.max(0, b.total - b.picked),
        fullyDeparted: (b.total>0 && b.picked===b.total),
        hcNeed,
        timeLeftStr: isPast ? 'PAST' : toHMS(tlMin),
        risk
      });
    }

    const future = computed.filter(b => !b.isPast && !b.fullyDeparted);
    const maxHCNeedAllFuture = future.reduce((m,b)=>Math.max(m,b.hcNeed), 0);
    const activeHC = activeHCGlobal;
    const hcSurplus = activeHC - maxHCNeedAllFuture;

    // Return all future rows; render will handle Safe toggle
    return {
      futureAll: future,
      meta: {
        now: (new Date()).toTimeString().slice(0,8),
        totalPLAll: norm.length,
        inProgAll: norm.filter(r=>r.state==='inprog').length,
        avgPLMin: avg,
        shiftEnd: CFG.shiftEndHHmm,
        activeHC,
        maxHCNeed: maxHCNeedAllFuture,
        hcSurplus
      }
    };
  }

  // ---------- UI (start collapsed + column-fit width + vivid colors + Safe toggle) ----------
  if (ON_PICK_TOP) {
    (function setupUI(){
      // Card width equals sum of fixed column widths (no scroll)
      const GRID_COLS = '88px 120px 140px 120px 110px 120px 110px';
      const GRID_GAP  = 12; // px

      const root = document.createElement('div');
      Object.assign(root.style,{
        position:'fixed',
        top:'72px',
        right:'16px',
        zIndex:2147483647,
        fontFamily:'Inter, system-ui, Segoe UI, Roboto, Arial',
        fontSize:'14px'
      });

      const card = document.createElement('div');
      Object.assign(card.style,{
        display:'inline-block',
        width:'auto',
        maxWidth:'none',
        background:'#fff',
        border:'1px solid #e5e7eb',
        borderRadius:'16px',
        boxShadow:'0 14px 32px rgba(0,0,0,.10)',
        overflow:'visible'
      });

      const head = document.createElement('div');
      Object.assign(head.style,{
        background:'#0284c7', color:'#fff', padding:'10px 12px',
        display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px'
      });
      const title = document.createElement('div');
      title.textContent = 'Pick Risk Waves';
      Object.assign(title.style,{fontWeight:800, letterSpacing:'.2px'});

      function mkLabeled(label,val){
        const wrap=document.createElement('label');
        Object.assign(wrap.style,{display:'flex',alignItems:'center',gap:'6px',fontSize:'13px'});
        const s=document.createElement('span'); s.textContent=label;
        const i=document.createElement('input');
        Object.assign(i.style,{border:'1px solid #d1d5db',borderRadius:'8px',padding:'5px 8px',minWidth:'72px',fontSize:'13px'});
        i.value=val; wrap.append(s,i); return {wrap,input:i};
      }
      function mkBtn(t){ const b=document.createElement('button'); b.textContent=t;
        Object.assign(b.style,{background:'#111827',color:'#fff',border:'none',padding:'7px 12px',borderRadius:'10px',cursor:'pointer',fontWeight:800,letterSpacing:'.2px',fontSize:'13px'});
        return b; }
      function mkToggle(label, init){
        const wrap=document.createElement('label');
        Object.assign(wrap.style,{display:'flex',alignItems:'center',gap:'6px',fontSize:'13px',cursor:'pointer'});
        const i=document.createElement('input'); i.type='checkbox'; i.checked=!!init;
        wrap.append(i, document.createTextNode(label)); return {wrap,input:i};
      }

      const inpAvg=mkLabeled('AVG PL MIN', CFG.avgPLMin);
      const inpShift=mkLabeled('End C1 (HH:MM)', CFG.shiftEndHHmm); // informational
      const togSafe = mkToggle('Show Safe waves', CFG.showSafe);    // NEW
      const btnRefresh=mkBtn('Refresh');
      const btnCollapse=mkBtn('Collapse');

      const controls=document.createElement('div');
      Object.assign(controls.style,{display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap'});
      controls.append(btnRefresh, inpAvg.wrap, inpShift.wrap, togSafe.wrap, btnCollapse);
      head.append(title, controls);

      const collapseTab=document.createElement('div'); collapseTab.textContent='Pick Risk';
      Object.assign(collapseTab.style,{position:'fixed',top:'72px',right:'16px',padding:'8px 12px',background:'#0284c7',color:'#fff',borderRadius:'10px',boxShadow:'0 6px 18px rgba(0,0,0,.14)',cursor:'pointer',display:'inline-block',zIndex:2147483647});

      const body=document.createElement('div');
      Object.assign(body.style,{
        padding:'10px 12px',
        color:'#111827',
        fontSize:'14px',
        overflow:'visible',
        width:`calc(88px + 120px + 140px + 120px + 110px + 120px + 110px + ${GRID_GAP * 6}px)`
      });

      const foot=document.createElement('div');
      foot.textContent='Instructions: Click "Refresh" above then download the picklists by clicking "Export to CSV". Ensure Filters are off.';
      Object.assign(foot.style,{padding:'10px 12px',borderTop:'1px solid #e5e7eb',fontSize:'12px',color:'#374151'});

      card.append(head, body, foot);
      root.append(card);
      document.documentElement.append(root, collapseTab);

      // Start collapsed
      card.style.display = 'none';

      // Collapsible
      btnCollapse.addEventListener('click',()=>{ card.style.display='none'; collapseTab.style.display='inline-block'; });
      head.addEventListener('dblclick',()=>{ card.style.display='none'; collapseTab.style.display='inline-block'; });
      collapseTab.addEventListener('click',()=>{ collapseTab.style.display='none'; card.style.display='inline-block'; });

      function esc(s){ return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
      function status(m){ body.innerHTML=`<div style="color:#374151">${esc(m)}</div>`; }
      function error(m){ body.innerHTML=`<div style="color:#b91c1c">${esc(m)}</div>`; }

      // Chips (add Safe + Proj Miss)
      function chip(r){
        const m={
          'Safe':      ['#dcfce7','#166534'],
          'Low Risk':  ['#dbeafe','#0c4a6e'],
          'High Risk': ['#fecaca','#7f1d1d'],
          'Proj Miss': ['#fecaca','#7f1d1d']
        };
        const c=m[r]||['#e5e7eb','#374151'];
        return `<span style="background:${c[0]};color:${c[1]};padding:4px 10px;border-radius:999px;font-weight:800;font-size:13px;letter-spacing:.2px">${esc(r)}</span>`;
      }
      function fmtHM(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

      function tile(label, value, color){
        return `
          <div style="display:flex;flex-direction:column;align-items:flex-start;line-height:1.15;white-space:nowrap">
            <div style="font-size:12px;letter-spacing:.2px;opacity:.75">${esc(label)}</div>
            <div style="font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px;${color?`color:${color}`:''}">
              ${esc(String(value))}
            </div>
          </div>
        `;
      }

      let lastResult = null;

      function render({futureAll, meta}){
        // filter by Safe toggle
        const table = CFG.showSafe ? futureAll : futureAll.filter(b => b.risk !== 'Safe');

        const summary = `
          <div style="display:flex;gap:14px;align-items:flex-end;margin-bottom:10px">
            ${tile('TIME', meta.now)}
            ${tile('Total', meta.totalPLAll)}
            ${tile('IP', meta.inProgAll)}
            ${tile('AVG', meta.avgPLMin)}
            ${tile('End', meta.shiftEnd)}
            ${tile('HCNeed', meta.maxHCNeed)}
            ${tile('Surplus', meta.hcSurplus, meta.hcSurplus>=0 ? '#166534' : '#b91c1c')}
          </div>
        `;

        let html = summary + `
          <div style="display:grid;grid-template-columns:${GRID_COLS};gap:${GRID_GAP}px;padding:8px 0;border-bottom:1px solid #e5e7eb;font-weight:800;white-space:nowrap;letter-spacing:.1px">
            <div>STAGE BY</div><div>Total Picklists</div><div>Lists Remaining</div><div>Not Assigned</div><div>HC Need</div><div>TIME LEFT</div><div>Risk?</div>
          </div>
        `;

        if (!table.length){
          body.innerHTML = html + `<div style="color:#374151;padding-top:8px">${CFG.showSafe?'No future waves.':'No at-risk waves (non-Safe, non-PAST, non-departed).'}</div>`;
          return;
        }

        html += table.map(b=>{
          const bg = b.risk==='Proj Miss' ? '#fee2e2'
                   : b.risk==='High Risk' ? '#fee2e2'
                   : b.risk==='Low Risk'  ? '#e0f2fe'
                   : '#ecfdf5'; // Safe
          const bar = b.risk==='Proj Miss' ? '#b91c1c'
                   : b.risk==='High Risk' ? '#b91c1c'
                   : b.risk==='Low Risk'  ? '#0369a1'
                   : '#16a34a';
          return `
            <div style="display:grid;grid-template-columns:${GRID_COLS};gap:${GRID_GAP}px;padding:8px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap;background:${bg};
                        position:relative;">
              <div style="position:absolute;left:-12px;top:0;bottom:0;width:6px;background:${bar};border-radius:6px"></div>
              <div><b>${fmtHM(b.stage)}</b></div>
              <div>${b.totals.total}</div>
              <div>${b.listsRemaining}</div>
              <div>${b.totals.unassigned}</div>
              <div>${b.hcNeed}</div>
              <div>${b.timeLeftStr}</div>
              <div>${chip(b.risk)}</div>
            </div>
          `;
        }).join('');

        body.innerHTML = html;
      }

      // Toggle Safe behavior
      function reRender(){ if (lastResult) render(lastResult); }
      togSafe.input.addEventListener('change', ()=>{ CFG.showSafe = !!togSafe.input.checked; persist(); reRender(); });

      // Refresh handler
      btnRefresh.addEventListener('click', async ()=>{
        CFG.avgPLMin = +inpAvg.input.value || CFG.avgPLMin;
        CFG.shiftEndHHmm = inpShift.input.value || CFG.shiftEndHHmm;
        persist();

        try{
          status('Armed: up to 15s to capture CSV… now click the page’s “Export to CSV”.');
          const csvText = await waitForCSVFromAnyFrame(15000);
          status('Parsing CSV…');
          const arr = parseCSV(csvText); if(!arr.length){ error('Empty CSV.'); return; }
          const header = arr[0], data = arr.slice(1);
          status('Computing (Excel parity)…');
          lastResult = computeFromCSV(data, header);
          render(lastResult);
        }catch(e){ error(String(e?.message||e)); }
      });

    })();
  }

  // ---------- Await CSV ----------
  function waitForCSVFromAnyFrame(timeoutMs=15000){
    return new Promise((resolve, reject)=>{
      let done=false;
      const to=setTimeout(()=>{cleanup(); reject(new Error('Could not capture CSV from Export (timeout).'));}, timeoutMs);
      function onMsg(ev){ const d=ev&&ev.data; if(!d||!d.__amzl_csv_capture__) return; if(done) return; done=true; cleanup();
        const t=d.text; if(typeof t==='string' && /[,;\r\n]/.test(t)) resolve(t); else reject(new Error('Captured blob did not look like CSV text.')); }
      function cleanup(){ window.removeEventListener('message', onMsg); clearTimeout(to); }
      window.addEventListener('message', onMsg);
    });
  }

})();
