/* Performance de Pagamentos — visualização local, sem envio dos arquivos ao Supabase.
 * Fontes reais devem ser importadas pelo usuário; dados demonstrativos são explicitamente sinalizados.
 */
(() => {
  "use strict";
  const moneyFmt = new Intl.NumberFormat("pt-BR", {style:"currency",currency:"BRL"});
  const smallFmt = new Intl.NumberFormat("pt-BR", {maximumFractionDigits:1});
  const pctFmt = new Intl.NumberFormat("pt-BR", {style:"percent",minimumFractionDigits:1,maximumFractionDigits:1});
  const colors = ["#2a91b7","#128447","#b8cd5c","#eea23b","#ea7741","#bf4548"];
  const bins = [
    {id:"early",label:"Antecipado",color:colors[0],test:d=>d<0},
    {id:"ontime",label:"No vencimento",color:colors[1],test:d=>d===0},
    {id:"1-7",label:"1–7 dias",color:colors[2],test:d=>d>=1&&d<=7},
    {id:"8-30",label:"8–30 dias",color:colors[3],test:d=>d>=8&&d<=30},
    {id:"31-60",label:"31–60 dias",color:colors[4],test:d=>d>=31&&d<=60},
    {id:"60+",label:"Mais de 60 dias",color:colors[5],test:d=>d>60}
  ];
  const state = {
    data:[], source:"none", sourceName:"", filtered:[], tableSearch:"",
    period:"all", rank:"value", orderBy:"payDate", orderDir:"desc", page:0,
    initialized:false, lastData:null, lastSource:"", timelineKey:""
  };
  const el=id=>document.getElementById(id);
  const escape=v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const money=v=>moneyFmt.format(Number(v)||0);
  const pct=v=>pctFmt.format(Number(v)||0);
  const date=v=>{
    if(!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))return "—";
    const s=String(v);return s.slice(8,10)+"/"+s.slice(5,7)+"/"+s.slice(0,4);
  };
  const compact=v=>{
    const n=Number(v)||0;
    return Math.abs(n)>=1e6?"R$ "+smallFmt.format(n/1e6)+" mi":
      Math.abs(n)>=1e3?"R$ "+smallFmt.format(n/1e3)+" mil":money(n);
  };
  const setText=(id,v)=>{if(el(id))el(id).textContent=v;};
  const num=(x)=>Number.isFinite(Number(x))?Number(x):0;
  function normalize(row){
    if(!row || !row.name || !row.payDate)return null;
    const delay=Number(row.delay);
    const amount=Number(row.value);
    if(!Number.isFinite(delay)||!Number.isFinite(amount)||!/^\d{4}-\d{2}-\d{2}$/.test(String(row.payDate)))return null;
    return {
      customer:String(row.customer||""),
      name:String(row.name||"").trim(),
      seller:String(row.seller||"").trim(),
      sap:String(row.sap||""),
      invoice:String(row.invoice||""),
      issueDate:String(row.issueDate||""),
      dueDate:String(row.dueDate||""),
      payDate:String(row.payDate||""),
      value:amount,delay
    };
  }
  function fillSelect(id,arr,placeholder) {
    const select=el(id);if(!select)return;
    const prev=select.value;
    select.replaceChildren();
    const base=document.createElement("option");base.value="all";base.textContent=placeholder;select.appendChild(base);
    Array.from(new Set(arr.filter(Boolean))).sort((a,b)=>a.localeCompare(b,"pt-BR")).forEach(v=>{
      const option=document.createElement("option");option.value=v;option.textContent=v;select.appendChild(option);
    });
    select.value=prev && [...select.options].some(o=>o.value===prev)?prev:"all";
  }
  function setSource(kind,name) {
    state.source=kind==="demo"?"demo":kind==="local"?"local":"none";
    state.sourceName=name||"";
    updateSource();
  }
  function updateSource(){
    const badge=el("paymentsSourceBadge"),info=el("paymentsSourceCopy");
    if(badge){
      badge.dataset.kind=state.source;
      badge.textContent=state.source==="demo"?"◉ DADOS DEMONSTRATIVOS":
        state.source==="local"?"● PLANILHA IMPORTADA NO NAVEGADOR":"○ NENHUMA BASE IMPORTADA";
    }
    if(info)info.textContent=state.source==="local"?
      (state.sourceName?state.sourceName+" • ":"")+"Os arquivos permanecem neste navegador, sem envio automático ao banco.":
      state.source==="demo"?"Exemplo fictício apenas para conhecer os gráficos; não representa dados reais.":
      "Importe uma planilha XLSX/CSV de pagamentos para começar a análise.";
    const c=el("paymentClearLocalBtn");if(c)c.disabled=state.source==="none";
  }
  function readControls(){
    return {
      search:(el("paySearch")?.value||"").trim().toLocaleLowerCase("pt-BR"),
      seller:el("paySeller")?.value||"all",
      status:el("payStatus")?.value||"all",
      band:el("payDelayBand")?.value||"all",
      min:num(el("payMinValue")?.value),
      onlyRecurring:Boolean(el("payRecurring")?.checked),
      start:el("payFrom")?.value||"",
      end:el("payTo")?.value||""
    };
  }
  function dayCutoff(days){
    const now=new Date();const d=new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()-days+1));return d.toISOString().slice(0,10);
  }
  function sourceRows(){
    const f=readControls();
    let rows=state.data.filter(r=>{
      if(f.search && ![r.name,r.customer,r.invoice,r.sap].join(" ").toLocaleLowerCase("pt-BR").includes(f.search))return false;
      if(f.seller!=="all" && r.seller!==f.seller)return false;
      if(f.status==="early" && r.delay>=0)return false;
      if(f.status==="onTime" && r.delay!==0)return false;
      if(f.status==="noDelay" && r.delay>0)return false;
      if(f.status==="late" && r.delay<=0)return false;
      if(f.band!=="all" && !bins.find(b=>b.id===f.band)?.test(r.delay))return false;
      if(f.min>0 && r.value<f.min)return false;
      if(state.period==="30" && r.payDate<dayCutoff(30))return false;
      if(state.period==="90" && r.payDate<dayCutoff(90))return false;
      if(state.period==="year" && r.payDate.slice(0,4)!==String(new Date().getFullYear()))return false;
      if(state.period==="custom" && ((f.start&&r.payDate<f.start)||(f.end&&r.payDate>f.end)))return false;
      return true;
    });
    if(f.onlyRecurring){
      // Recorrência: ao menos dois pagamentos feitos com atraso pelo mesmo cliente, após os demais filtros.
      const counts=new Map();
      rows.filter(r=>r.delay>0).forEach(r=>{
        const key=r.customer||r.name.toLocaleLowerCase("pt-BR");
        counts.set(key,(counts.get(key)||0)+1);
      });
      rows=rows.filter(r=>counts.get(r.customer||r.name.toLocaleLowerCase("pt-BR"))>=2);
    }
    return rows;
  }
  function groupedClients(rows){
    const map=new Map();
    rows.forEach(r=>{
      const key=r.customer||r.name.toLocaleLowerCase("pt-BR");
      const g=map.get(key)||{name:r.name,lateCount:0,lateValue:0,lateDelay:0,allCount:0};
      g.allCount++;
      if(r.delay>0){g.lateCount++;g.lateValue+=r.value;g.lateDelay+=r.delay;}
      map.set(key,g);
    });
    return [...map.values()].map(x=>({...x,averageDelay:x.lateCount?x.lateDelay/x.lateCount:0}));
  }
  function renderKpis(rows){
    const total=rows.reduce((a,r)=>a+r.value,0);
    const on=rows.filter(r=>r.delay<=0),late=rows.filter(r=>r.delay>0);
    const onValue=on.reduce((a,r)=>a+r.value,0);
    const lateValue=late.reduce((a,r)=>a+r.value,0);
    const avg=late.length?late.reduce((a,r)=>a+r.delay,0)/late.length:0;
    const maximum=late.reduce((m,r)=>Math.max(m,r.delay),0);
    const recurring=groupedClients(rows).filter(r=>r.lateCount>=2).length;
    const empty=!state.data.length, noMatches=!rows.length;
    setText("payKpiTotal",empty?"—":money(total));
    setText("payKpiTotalHint",empty?"Aguardando arquivo":rows.length+" pagamentos registrados");
    setText("payKpiOn",empty?"—":pct(rows.length?on.length/rows.length:0));
    setText("payKpiOnHint",noMatches?"Sem pagamentos no filtro":on.length+" pagamentos • "+compact(onValue));
    setText("payKpiLate",empty?"—":pct(rows.length?late.length/rows.length:0));
    setText("payKpiLateHint",noMatches?"Sem pagamentos no filtro":late.length+" pagamentos • "+compact(lateValue));
    setText("payKpiAvg",empty?"—":smallFmt.format(avg)+" dias");
    setText("payKpiAvgHint",late.length? "Média entre pagamentos atrasados":"Nenhum atraso registrado");
    setText("payKpiMax",empty?"—":maximum+" dias");
    setText("payKpiMaxHint",late.length?"Maior atraso liquidado":"Nenhum atraso registrado");
    setText("payKpiRepeat",empty?"—":String(recurring));
    setText("payKpiRepeatHint",empty?"Aguardando arquivo":"Clientes com 2+ pagamentos em atraso");
    setText("payRecordsCount",rows.length+" de "+state.data.length+" pagamentos");
  }
  function monthlyData(rows){
    const map=new Map();
    rows.forEach(r=>{
      const key=r.payDate.slice(0,7);
      const m=map.get(key)||{month:key,total:0,count:0,noDelay:0};
      m.total+=r.value;m.count++;
      if(r.delay<=0)m.noDelay++;
      map.set(key,m);
    });
    return [...map.values()].sort((a,b)=>a.month.localeCompare(b.month)).slice(-12);
  }
  function chartEmpty(target,description){
    const e=el(target);if(e)e.innerHTML='<div class="payments-empty"><strong>Sem dados para este gráfico</strong>'+escape(description)+'</div>';
  }
  function renderMonthly(rows){
    const data=monthlyData(rows),target=el("payMonthlyChart");
    if(!target)return;
    if(!data.length){chartEmpty("payMonthlyChart","Selecione um período com pagamentos.");return;}
    const W=740,H=280,L=65,R=35,T=26,B=56,areaW=W-L-R,areaH=H-T-B;
    const maxValue=Math.max(1,...data.map(d=>d.total)),step=areaW/data.length;
    const height=v=>Math.max(0,v)/maxValue*areaH;
    const grid=[0,.25,.5,.75,1].map(t=>{
      const y=T+areaH*(1-t);
      return '<line x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'" stroke="#e8eee6"/>'+
        '<text x="'+(L-8)+'" y="'+(y+4)+'" text-anchor="end" fill="#7b8a80" font-size="10">'+
        escape(compact(maxValue*t).replace("R$ ",""))+'</text>';
    }).join("");
    const bars=data.map((d,i)=>{
      const w=Math.max(9,Math.min(47,step*.57)),x=L+step*i+step/2-w/2,h=height(d.total);
      const y=T+areaH-h;
      return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="5" fill="#0e7b4b">'+
        '<title>'+escape(d.month)+': '+escape(money(d.total))+' • '+d.count+' pagamentos</title></rect>'+
        '<text x="'+(x+w/2)+'" y="'+(H-30)+'" fill="#647969" text-anchor="middle" font-size="10">'+
        escape(d.month.slice(5)+"/"+d.month.slice(2,4))+'</text>';
    }).join("");
    const linePoints=data.map((d,i)=>{
      const x=L+step*i+step/2,y=T+areaH*(1-d.noDelay/d.count);
      return [x,y];
    });
    const line='<polyline points="'+linePoints.map(p=>p.join(",")).join(" ")+'" fill="none" stroke="#eea63b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'+
      linePoints.map((p,i)=>'<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="#eea63b" stroke="white" stroke-width="1.5">'+
      '<title>'+escape(data[i].month)+': '+escape(pct(data[i].noDelay/data[i].count))+' no prazo/antecipado</title></circle>').join("");
    target.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Barras de valores recebidos por mês e linha de percentual sem atraso" xmlns="http://www.w3.org/2000/svg">'+grid+bars+line+'</svg>';
  }
  function renderDonut(rows){
    const target=el("payDonut"),legend=el("payDonutLegend");if(!target||!legend)return;
    const n=rows.length;
    if(!n){
      target.style.background="#e6efe5";
      setText("payDonutPct","—");setText("payDonutCaption","Sem pagamentos");
      legend.innerHTML='<span class="payments-muted">Os percentuais aparecerão após a importação.</span>';
      return;
    }
    let cumulative=0;
    const slices=bins.map(b=>{
      const count=rows.filter(r=>b.test(r.delay)).length;
      const from=cumulative;cumulative+=100*count/n;
      return {count,from,to:cumulative,color:b.color,label:b.label};
    });
    target.style.background="conic-gradient("+slices.map(s=>s.color+" "+s.from+"% "+s.to+"%").join(",")+")";
    const noDelay=rows.filter(r=>r.delay<=0).length;
    setText("payDonutPct",pct(noDelay/n));
    setText("payDonutCaption","sem atraso");
    legend.innerHTML=slices.map(s=>
      '<div class="payments-donut-list__line"><span><i class="payments-dot" style="background:'+s.color+'"></i>'+
      escape(s.label)+'</span><strong>'+s.count+' • '+pct(s.count/n)+'</strong></div>').join("");
  }
  function renderBands(rows){
    const root=el("payBands");if(!root)return;
    if(!rows.length){root.innerHTML='<div class="payments-empty">Sem pagamentos neste período.</div>';return;}
    const max=Math.max(1,...bins.map(b=>rows.filter(r=>b.test(r.delay)).length));
    root.innerHTML=bins.map(b=>{
      const subset=rows.filter(r=>b.test(r.delay)),val=subset.reduce((a,r)=>a+r.value,0);
      return '<div class="payments-band" title="'+escape(money(val))+' recebido"><strong>'+escape(b.label)+'</strong>'+
        '<div class="payments-band__track"><div class="payments-band__fill" style="width:'+(subset.length/max*100)+'%;background:'+b.color+'"></div></div>'+
        '<span class="payments-band__meta">'+subset.length+' • '+pct(subset.length/rows.length)+'</span></div>';
    }).join("");
  }
  function renderRankings(rows){
    const target=el("payRanking");if(!target)return;
    const relevant=groupedClients(rows).filter(x=>x.lateCount);
    const metric=state.rank==="delay"?"averageDelay":state.rank==="recurrence"?"lateCount":"lateValue";
    const ordered=relevant.sort((a,b)=>b[metric]-a[metric]).slice(0,8);
    if(!ordered.length){target.innerHTML='<div class="payments-empty">Nenhum pagamento em atraso neste período.</div>';return;}
    const max=Math.max(1,...ordered.map(x=>x[metric]));
    target.innerHTML=ordered.map((x,i)=>{
      const value=metric==="lateValue"?compact(x.lateValue):
        metric==="averageDelay"?smallFmt.format(x.averageDelay)+" dias":x.lateCount+" atrasos";
      return '<div class="payments-rank" title="'+escape(x.name)+'"><span class="payments-rank__n">'+(i+1)+'</span>'+
        '<div><div class="payments-rank__name">'+escape(x.name)+'</div>'+
        '<div class="payments-rank__bar"><span style="width:'+(x[metric]/max*100)+'%"></span></div></div>'+
        '<strong class="payments-rank__amount">'+escape(value)+'</strong></div>';
    }).join("");
  }
  function renderInsights(rows){
    const target=el("payInsights");if(!target)return;
    if(!rows.length){target.innerHTML='<div class="payments-insight"><strong>Aguardando dados</strong><p>Importe uma planilha real para obter diagnósticos baseados nos pagamentos.</p></div>';return;}
    const late=rows.filter(r=>r.delay>0),lateValue=late.reduce((a,r)=>a+r.value,0);
    const severe=rows.filter(r=>r.delay>30),on=rows.filter(r=>r.delay<=0);
    const ranked=groupedClients(rows).sort((a,b)=>b.lateValue-a.lateValue);
    const most=ranked.find(x=>x.lateValue>0);
    const points=[
      ["Pontualidade",on.length+" de "+rows.length+" pagamentos ocorreram até a data de vencimento ("+pct(on.length/rows.length)+")."],
      ["Atrasos relevantes",severe.length+" pagamentos com mais de 30 dias de atraso, totalizando "+money(severe.reduce((a,r)=>a+r.value,0))+"."],
      ["Concentração do atraso",most?
        most.name+" representa "+pct(most.lateValue/(lateValue||1))+" do valor pago com atraso neste filtro.":"Nenhum cliente possui pagamentos em atraso neste filtro."]
    ];
    target.innerHTML=points.map(p=>'<div class="payments-insight"><strong>'+escape(p[0])+'</strong><p>'+escape(p[1])+'</p></div>').join("");
  }
  function sortedRows(rows){
    const key=state.orderBy,dir=state.orderDir==="desc"?-1:1;
    return [...rows].sort((a,b)=>{
      const va=a[key]??"",vb=b[key]??"";
      if(["delay","value"].includes(key))return (num(va)-num(vb))*dir;
      return String(va).localeCompare(String(vb),"pt-BR",{numeric:true})*dir;
    });
  }
  function statusFor(r){return r.delay>0?{label:"Atrasado",css:"late"}:
    r.delay<0?{label:"Antecipado",css:"early"}:{label:"No prazo",css:"on"};}
  function renderTable(rows){
    const body=el("paymentDetailTable");if(!body)return;
    let list=rows;
    const q=state.tableSearch.trim().toLocaleLowerCase("pt-BR");
    if(q)list=list.filter(r=>[r.name,r.customer,r.sap,r.invoice,r.seller,r.payDate].join(" ").toLocaleLowerCase("pt-BR").includes(q));
    list=sortedRows(list);
    const per=25,pages=Math.max(1,Math.ceil(list.length/per));
    state.page=Math.min(state.page,pages-1);
    const pageRows=list.slice(state.page*per,(state.page+1)*per);
    body.innerHTML=pageRows.length?pageRows.map(r=>{
      const status=statusFor(r);
      return '<tr><td><strong>'+escape(r.name)+'</strong><br><small>'+escape(r.customer||"—")+'</small></td>'+
        '<td>'+escape(r.sap||"—")+'</td><td>'+escape(r.invoice||"—")+'</td>'+
        '<td>'+date(r.issueDate)+'</td><td>'+date(r.dueDate)+'</td><td>'+date(r.payDate)+'</td>'+
        '<td><strong>'+escape(money(r.value))+'</strong></td>'+
        '<td>'+(r.delay>0?"+":"")+r.delay+'</td>'+
        '<td><span class="payments-badge payments-badge--'+status.css+'">'+status.label+'</span></td>'+
        '<td>'+escape(r.seller||"—")+'</td></tr>';
    }).join(""):'<tr><td colspan="10" class="payments-empty">Nenhum pagamento corresponde aos filtros. Ajuste a pesquisa ou importe uma planilha.</td></tr>';
    setText("payTableInfo",list.length+" registros • página "+(state.page+1)+" de "+pages);
    const prev=el("payPagePrev"),next=el("payPageNext");
    if(prev)prev.disabled=state.page===0;
    if(next)next.disabled=state.page+1>=pages;
    document.querySelectorAll("#historico-pagamentos .payments-table th button[data-sort]").forEach(b=>{
      b.setAttribute("aria-sort",state.orderBy===b.dataset.sort?(state.orderDir==="asc"?"ascending":"descending"):"none");
    });
    return list;
  }
  function renderTimeline(rows){
    const details=el("paymentsTimelineDetails"),timeline=el("paymentTimeline");
    if(!details?.open||!timeline)return;
    const key=rows.length+"|"+(rows[0]?.payDate||"")+"|"+(rows.at(-1)?.payDate||"")+"|"+state.source+"|"+state.period;
    if(state.timelineKey===key && state.lastTimelineRows===rows)return;
    timeline.data=rows.map((r,i)=>({
      id:i+1,client:r.name,dueDate:r.dueDate,paymentDate:r.payDate,amount:r.value,daysDelay:r.delay
    }));
    state.timelineKey=key;state.lastTimelineRows=rows;
  }
  function downloadCSV(rows){
    if(!rows.length)return;
    const header=["Cliente","Código cliente","Vendedor","SAP","Nota Fiscal","Emissão","Vencimento","Pagamento","Valor","Dias de atraso","Situação"];
    const escCsv=v=>{
      const raw=String(v??"");
      // Impede fórmula injetada ao abrir CSV em Excel/LibreOffice.
      const safe=/^[\\s]*[=+@-]/.test(raw) && !/^-?\\d+(?:[.,]\\d+)?$/.test(raw.trim())?"'"+raw:raw;
      return '"'+safe.replace(/"/g,'""')+'"';
    };
    const content=[header,...rows.map(r=>[r.name,r.customer,r.seller,r.sap,r.invoice,r.issueDate,r.dueDate,r.payDate,r.value.toFixed(2).replace(".",","),r.delay,statusFor(r).label])]
      .map(cols=>cols.map(escCsv).join(";")).join("\r\n");
    const blob=new Blob(["\uFEFF"+content],{type:"text/csv;charset=utf-8;"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");link.href=url;link.download="pagamentos-filtrados-"+new Date().toISOString().slice(0,10)+".csv";
    document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  function applyFilter(){
    state.page=0;
    state.filtered=sourceRows();
    renderKpis(state.filtered);
    renderMonthly(state.filtered);
    renderDonut(state.filtered);
    renderBands(state.filtered);
    renderRankings(state.filtered);
    renderInsights(state.filtered);
    renderTable(state.filtered);
    renderTimeline(state.filtered);
  }
  function setPeriod(value){
    state.period=value;
    document.querySelectorAll("[data-pay-period]").forEach(button=>{
      button.setAttribute("aria-pressed",String(button.dataset.payPeriod===value));
    });
    const extra=el("payCustomDates");
    if(extra)extra.hidden=value!=="custom";
    applyFilter();
  }
  function onInputChange(){
    state.timelineKey="";
    applyFilter();
  }
  function init(){
    if(state.initialized||!el("historico-pagamentos"))return;
    state.initialized=true;
    const filterNames=["paySearch","paySeller","payStatus","payDelayBand","payMinValue","payRecurring","payFrom","payTo"];
    filterNames.forEach(name=>{
      const input=el(name);
      if(input)input.addEventListener(name==="paySearch"||name==="payMinValue"?"input":"change",onInputChange);
    });
    document.querySelectorAll("[data-pay-period]").forEach(button=>button.addEventListener("click",()=>setPeriod(button.dataset.payPeriod)));
    document.querySelectorAll("[data-pay-rank]").forEach(button=>button.addEventListener("click",()=>{
      state.rank=button.dataset.payRank;
      document.querySelectorAll("[data-pay-rank]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.payRank===state.rank)));
      renderRankings(state.filtered);
    }));
    el("payTableSearch")?.addEventListener("input",event=>{state.tableSearch=event.target.value;state.page=0;renderTable(state.filtered);});
    document.querySelectorAll("#historico-pagamentos .payments-table th button[data-sort]").forEach(button=>button.addEventListener("click",()=>{
      const k=button.dataset.sort;
      if(state.orderBy===k)state.orderDir=state.orderDir==="asc"?"desc":"asc";
      else{state.orderBy=k;state.orderDir="asc";}
      state.page=0;renderTable(state.filtered);
    }));
    el("payPagePrev")?.addEventListener("click",()=>{state.page=Math.max(0,state.page-1);renderTable(state.filtered);});
    el("payPageNext")?.addEventListener("click",()=>{state.page++;renderTable(state.filtered);});
    el("payExportBtn")?.addEventListener("click",()=>downloadCSV(sortedRows(state.filtered)));
    el("payExportTableBtn")?.addEventListener("click",()=>downloadCSV(sortedRows(state.filtered).filter(r=>!state.tableSearch||[r.name,r.customer,r.sap,r.invoice,r.seller].join(" ").toLocaleLowerCase("pt-BR").includes(state.tableSearch.toLocaleLowerCase("pt-BR")))));
    el("payReset")?.addEventListener("click",()=>{
      ["paySearch","payMinValue","payFrom","payTo","payTableSearch"].forEach(id=>{if(el(id))el(id).value="";});
      ["paySeller","payStatus","payDelayBand"].forEach(id=>{if(el(id))el(id).value="all";});
      if(el("payRecurring"))el("payRecurring").checked=false;
      state.tableSearch="";setPeriod("all");
    });
    el("paymentsTimelineDetails")?.addEventListener("toggle",()=>{state.timelineKey="";renderTimeline(state.filtered);});
    el("paymentClearLocalBtn")?.addEventListener("click",async()=>{
      if(!window.confirm("Limpar a base de pagamentos deste navegador? Os arquivos no seu computador e o Supabase não serão alterados."))return;
      if(window.idbKeyval)try{await window.idbKeyval.del("compo_payment_data_v1");}catch(e){console.warn(e);}
      state.data=[];state.lastData=[];setSource("none","");
      if(window.paymentDataReset)window.paymentDataReset();
      fillSelect("paySeller",[],"Todos os vendedores");applyFilter();
    });
    updateSource();setPeriod("all");
  }
  function render(rows){
    init();
    if(!Array.isArray(rows))rows=[];
    // Evitar recalcular todos os charts em cada resize quando a base não mudou.
    if(state.lastData!==rows){
      state.data=rows.map(normalize).filter(Boolean);
      state.lastData=rows;
      fillSelect("paySeller",state.data.map(r=>r.seller),"Todos os vendedores");
      state.timelineKey="";
    }
    if(!state.data.length && state.source!=="none")setSource("none","");
    applyFilter();
  }
  async function persist(rows,filename){
    if(!window.idbKeyval)return;
    try{await window.idbKeyval.set("compo_payment_data_v1",{rows,filename,updated:new Date().toISOString()});}
    catch(error){console.warn("Não foi possível guardar pagamentos neste navegador:",error);}
  }
  async function restore(){
    if(!window.idbKeyval)return null;
    try{
      const data=await window.idbKeyval.get("compo_payment_data_v1");
      return data&&Array.isArray(data.rows)?data:null;
    }catch(error){console.warn("Não foi possível restaurar histórico local",error);return null;}
  }
  window.PaymentDashboard={render,setSource,persist,restore,getFiltered:()=>state.filtered.slice()};
  document.addEventListener("DOMContentLoaded",init);
})();
