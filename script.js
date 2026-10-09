const fmtMoney = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', minimumFractionDigits:2, maximumFractionDigits:2 });
const fmtMoneyFull = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', minimumFractionDigits:2, maximumFractionDigits:2 });
const fmtDate = new Intl.DateTimeFormat('pt-BR');
const fmtOneDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits:1 });
const colors = { green:'#64b32e', dark:'#245a24', soft:'#dcedd3', danger:'#c64444', grid:'#e6eee1', muted:'#667366' };
const $ = id => document.getElementById(id);

const state = {
  pendingImport: null,
  allOpenRows: [],
  overdueRows: [],
  analysis: {},
  history: [],
  selectedYears: new Set(),
  rjChecks: new Map(),
  rjLoading: new Set(),
  customerRegistry: [],
  paymentBase: [],
  rjScope: 'financial',
  sourceFile: '',
  updatedAt: ''
};

const importFields = [
  { key:'codigo', label:'Código PN', aliases:['codigo pn','código pn','codigo','cod pn','cod','pn'] },
  { key:'cnpj', label:'CNPJ', aliases:['cnpj','cpf/cnpj','cpf cnpj','documento fiscal','doc fiscal'] },
  { key:'cliente', label:'Razão Social', aliases:['razao social','razão social','cliente','nome do cliente','nome','rotulos de linha','rótulos de linha','clientes'] },
  { key:'documento', label:'Nº Documento', aliases:['no.docto.','nº documento','no documento','documento','doc','no/docto/','no/docto','doc sap','lcm'] },
  { key:'nf', label:'Nº NF', aliases:['no. nf','nº nf','no nf','nf','nota fiscal','no/ nf','no/nf'] },
  { key:'emissao', label:'Emissão', aliases:['emissao','emissão','data emissao','data emissão'] },
  { key:'vencimento', label:'Vencimento', aliases:['vencimento','data vencimento','dt vencimento','vencimento parcela','novo vencimento','vencimentos'] },
  { key:'valor', label:'Valor R$', aliases:['valor r$','valor','saldo','valor em aberto','saldo em aberto','saldo a pagar','soma de valor r$','soma de saldo a pagar','total prestação','total prestacao'] },
  { key:'dias', label:'Dias Atraso', aliases:['dias atraso','dias em atraso','dias','máx. de dias atraso','max. de dias atraso','max de dias atraso','máx de dias atraso'] },
  { key:'observacoes', label:'Observações', aliases:['observacoes','observações','obs','motivo','garantias'] },
  { key:'gestor', label:'Vendedor', aliases:['vendedor','gestor','responsavel','responsável'] }
];

function normalizeHeader(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function parseMoney(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  const clean = String(value || '').replace(/R\$/gi,'').replace(/\s/g,'');
  return clean ? Number(clean.includes(',') ? clean.replace(/\./g,'').replace(',','.') : clean) : NaN;
}

function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0,10);
  if (typeof value === 'number' && window.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;
  }
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0,10);
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return br ? `${br[3]}-${br[2].padStart(2,'0')}-${br[1].padStart(2,'0')}` : text;
}

function showDate(value) {
  if (!value) return '—';
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const [y, m, d] = str.slice(0,10).split('-');
    return `${d}/${m}/${y}`;
  }
  const date = new Date(`${str}T12:00:00`);
  return Number.isNaN(date.getTime()) ? str : fmtDate.format(date);
}

function agingFromDays(days) {
  const d = Number(days) || 0;
  return d <= 0 ? 'A vencer' : d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '+90';
}

function statusFromRow(row, extra={}) {
  const context = normalizeHeader([row.observacoes, extra.cobranca, extra.negociacao, extra.providencia].filter(Boolean).join(' '));
  if (context.includes('recuperacao judicial') || context.includes('em recuperacao') || /\brj\b/.test(context)) return 'RECUPERAÇÃO JUDICIAL';
  return Number(row.dias) > 0 ? 'EM ATRASO' : 'EM DIA';
}

function enrichRow(row, analysis={}) {
  const extra = analysis[row.cliente] || {};
  return { ...row, ...extra, aging: agingFromDays(Number(row.dias)), status: statusFromRow(row, extra) };
}

function sum(values) {
  return values.reduce((a,b) => a + (Number(b) || 0), 0);
}

function formatAxisMoney(value){
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1000000) return `R$ ${Math.round(amount/1000000)} mi`;
  if (Math.abs(amount) >= 1000) return `R$ ${Math.round(amount/1000)} mil`;
  return `R$ ${Math.round(amount)}`;
}

function groupBy(rows, field) {
  const map = new Map();
  rows.forEach(r => map.set(r[field] || 'Não informado', (map.get(r[field] || 'Não informado') || 0) + (Number(r.valor) || 0)));
  return [...map.entries()].map(([key, total]) => ({ key, total })).sort((a,b) => b.total - a.total);
}

function uniqueValues(field) {
  const values = new Set();
  (state.allOpenRows || []).forEach(r => { if (r[field]) values.add(r[field]); });
  (state.overdueRows || []).forEach(r => { if (r[field]) values.add(r[field]); });
  (state.history || []).forEach(snapshot => {
    (snapshot.allOpen || []).forEach(r => { if (r[field]) values.add(r[field]); });
    (snapshot.overdue || []).forEach(r => { if (r[field]) values.add(r[field]); });
  });
  (state.customerRegistry || []).forEach(r => { if (r[field]) values.add(r[field]); });
  (state.paymentBase || []).forEach(r => { if (r[field]) values.add(r[field]); });
  if (field === 'status') values.add('PAGO (Histórico)');
  return ['Todos', ...[...values].sort((a, b) => String(a).localeCompare(String(b)))];
}

function fillSelect(id, values) {
  const el = $(id);
  if (!el) return;
  const current = el.value;
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (values.includes(current)) el.value = current;
}

function refreshFilters() {
  fillSelect('clienteFilter', uniqueValues('cliente'));
  fillSelect('gestorFilter', uniqueValues('gestor'));
  fillSelect('statusFilter', uniqueValues('status'));
}

function availableYears(){
  return [...new Set(state.history.map(s => String(s.date || '').slice(0,4)).filter(y => /^\d{4}$/.test(y)))].sort((a,b) => b.localeCompare(a));
}

function updateYearSummary(){
  const years = availableYears();
  const selected = [...state.selectedYears].sort((a,b) => b.localeCompare(a));
  const summary = $('yearSummary');
  if (!summary) return;
  summary.textContent = !selected.length || selected.length === years.length
    ? 'Todos os anos'
    : selected.length <= 2
      ? selected.join(' e ')
      : `${selected.length} anos selecionados`;
}

function refreshYearFilter(){
  const years = availableYears();
  state.selectedYears = new Set();
  const opts = $('yearOptions');
  if (!opts) return;
  opts.innerHTML = `<label><input type="checkbox" data-all checked> Todos os anos</label>${years.map(y => `<label><input type="checkbox" value="${y}"> ${y}</label>`).join('')}`;
  opts.onchange = event => {
    const inputs = [...opts.querySelectorAll('input:not([data-all])')];
    const all = opts.querySelector('[data-all]');
    if (event.target.hasAttribute('data-all')) {
      all.checked = true;
      inputs.forEach(input => { input.checked = false; });
      state.selectedYears = new Set();
    } else {
      all.checked = false;
      const selected = inputs.filter(input => input.checked).map(input => input.value);
      if (!selected.length) all.checked = true;
      state.selectedYears = new Set(selected);
    }
    $('periodoFilter').value = '0';
    updateYearSummary();
    renderAll();
  };
  updateYearSummary();
}

function currentFilters() {
  return {
    cliente: $('clienteFilter')?.value || 'Todos',
    gestor: $('gestorFilter')?.value || 'Todos',
    status: $('statusFilter')?.value || 'Todos',
    periodo: Number($('periodoFilter')?.value || 0),
    search: ($('globalSearch')?.value || '').trim().toLowerCase()
  };
}

function selectedSnapshots(){
  let snapshots = state.history.filter(s => !state.selectedYears.size || state.selectedYears.has(String(s.date).slice(0,4))).sort((a,b) => a.date.localeCompare(b.date));
  const months = currentFilters().periodo;
  if (months && snapshots.length) {
    const latest = new Date(`${snapshots.at(-1).date}T12:00:00`);
    const cutoff = new Date(latest.getFullYear(), latest.getMonth() - months + 1, 1);
    snapshots = snapshots.filter(s => new Date(`${s.date}T12:00:00`) >= cutoff);
  }
  return snapshots;
}

function filterRows(rows){
  const f = currentFilters();
  return (rows || []).filter(r => {
    const cliente = String(r.cliente || '');
    const codigo = String(r.codigo || '');
    const matchCliente = f.cliente === 'Todos' || cliente === f.cliente;
    const matchGestor = f.gestor === 'Todos' || r.gestor === f.gestor;
    const matchStatus = f.status === 'Todos' || r.status === f.status;
    const matchSearch = !f.search || cliente.toLowerCase().includes(f.search) || codigo.toLowerCase().includes(f.search);
    return matchCliente && matchGestor && matchStatus && matchSearch;
  });
}

function filteredTitles(){
  const f = currentFilters();
  if (f.status === 'PAGO (Histórico)') return historicalFilteredTitles();
  
  const snapshots = selectedSnapshots();
  if (!snapshots.length) return [];
  return filterRows(snapshots.at(-1).overdue || []);
}

function historicalFilteredTitles() {
  const snapshots = selectedSnapshots();
  if (!snapshots.length) return [];
  
  const map = new Map();
  snapshots.forEach((snap, idx) => {
    const isLatest = idx === snapshots.length - 1;
    (snap.overdue || []).forEach(r => {
      const key = `${r.cliente}-${r.documento}-${r.nf}`;
      const existing = map.get(key);
      if (!existing || Number(r.dias) >= Number(existing.dias)) {
        map.set(key, { ...r, _isLatest: isLatest });
      } else {
        if (isLatest) existing._isLatest = true;
      }
    });
  });

  const result = [];
  for (const r of map.values()) {
    if (!r._isLatest && r.status !== 'RECUPERAÇÃO JUDICIAL') {
      r.status = 'PAGO (Histórico)';
    }
    result.push(r);
  }
  return filterRows(result.sort((a,b) => new Date(b.vencimento) - new Date(a.vencimento)));
}

function monthKey(value){
  return /^\d{4}-\d{2}/.test(value || '') ? value.slice(0,7) : 'Sem data';
}

function monthLabel(key){
  if (key === 'Sem data') return key;
  const [year, month] = key.split('-');
  return `${['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][Number(month)-1]}/${year.slice(2)}`;
}

function evolutionData(){
  const monthly = new Map();
  filteredTitles().filter(row => Number(row.dias) > 0).forEach(row => {
    const key = monthKey(row.vencimento);
    const item = monthly.get(key) || { total:0, titles:0 };
    item.total += (Number(row.valor) || 0);
    item.titles++;
    monthly.set(key, item);
  });
  const entries = [...monthly.entries()].filter(([key]) => key !== 'Sem data').sort(([a],[b]) => a.localeCompare(b));
  return {
    labels: entries.length ? entries.map(([key]) => monthLabel(key)) : ['Sem dados'],
    values: entries.length ? entries.map(([,item]) => item.total) : [0],
    titles: entries.length ? entries.map(([,item]) => item.titles) : [0]
  };
}

function monthlySnapshots(){
  const monthly = new Map();
  selectedSnapshots().forEach(snapshot => {
    const key = monthKey(snapshot.date);
    const current = monthly.get(key);
    if (key !== 'Sem data' && (!current || snapshot.date > current.date)) monthly.set(key, snapshot);
  });
  return [...monthly.values()].sort((a,b) => a.date.localeCompare(b.date));
}

function financialHistoryData(){
  const snapshots = monthlySnapshots();
  const labels = snapshots.map(s => monthLabel(monthKey(s.date)));
  const open = snapshots.map(s => {
    const sumAll = sum(filterRows(s.allOpen || []).map(r => r.valor));
    const sumOv = sum(filterRows(s.overdue || []).map(r => r.valor));
    return sumAll > 0 ? sumAll : sumOv;
  });
  const overdue = snapshots.map((s, i) => {
    const ov = filterRows(s.overdue || []).filter(r => Number(r.dias) > 0);
    return sum(ov.map(r => r.valor));
  });
  return {
    labels: labels.length ? labels : ['Sem dados'],
    open: open.length ? open : [0],
    overdue: overdue.length ? overdue : [0]
  };
}

function drawAxes(ctx, w, h, p){
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = p.top + (h - p.top - p.bottom) * i / 4;
    ctx.beginPath();
    ctx.moveTo(p.left, y);
    ctx.lineTo(w - p.right, y);
    ctx.stroke();
  }
}

function prepareCanvas(canvas, defaultW=620, defaultH=300){
  if (!canvas) return null;
  if (!canvas.dataset.baseW) {
    canvas.dataset.baseW = canvas.getAttribute('width') || defaultW;
    canvas.dataset.baseH = canvas.getAttribute('height') || defaultH;
  }
  const baseW = Number(canvas.dataset.baseW) || defaultW;
  const baseH = Number(canvas.dataset.baseH) || defaultH;
  const ratio = baseH / baseW;
  
  const parent = canvas.parentElement;
  const parentW = parent ? parent.clientWidth : 0;
  const clientW = canvas.clientWidth || parentW;
  const w = clientW > 40 ? clientW : baseW;
  const h = Math.max(120, Math.round(w * ratio));
  
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawLineChart(canvas, labels, series, options={}){
  if (!canvas) return;
  const prep = prepareCanvas(canvas, 1280, 390);
  if (!prep) return;
  const { ctx, w, h } = prep;
  const p = { left: 86, right: 28, top: 25, bottom: 46 };
  drawAxes(ctx, w, h, p);

  const rawMax = Math.max(0, ...series.flatMap(s => s.data));
  const hasValues = rawMax > 0;
  const max = hasValues ? rawMax * 1.12 : 1;
  const x = i => p.left + i * (w - p.left - p.right) / Math.max(1, labels.length - 1);
  const y = v => h - p.bottom - (v / max) * (h - p.top - p.bottom);

  canvas._chartPoints = labels.map((label, i) => ({
    label,
    x: x(i),
    y: y(series[0]?.data[i] || 0),
    value: series[0]?.data[i] || 0
  }));

  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const val = hasValues ? max * (1 - i / 4) : 0;
    const label = options.percent ? `${(val * 100).toFixed(0)}%` : options.integer ? Math.round(val) : formatAxisMoney(val);
    ctx.fillText(label, p.left - 10, p.top + (h - p.top - p.bottom) * i / 4 + 4);
  }

  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.ceil(labels.length / 10));
  labels.forEach((l, i) => {
    if (i % labelStep === 0 || i === labels.length - 1) {
      ctx.fillText(l, x(i), h - 18);
    }
  });

  series.forEach(s => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 3;
    ctx.setLineDash(s.dash || []);
    ctx.beginPath();
    s.data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.stroke();
    ctx.setLineDash([]);

    s.data.forEach((v, i) => {
      ctx.beginPath();
      ctx.fillStyle = s.pointColors?.[i] || s.color;
      ctx.arc(x(i), y(v), s.pointSizes?.[i] || s.point || 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

function drawBarChart(canvas, labels, values, horizontal=false){
  if (!canvas) return;
  const prep = prepareCanvas(canvas, 620, 300);
  if (!prep) return;
  const { ctx, w, h } = prep;
  const p = { left: horizontal ? 105 : 55, right: 24, top: 20, bottom: 52 };
  const rawMax = Math.max(0, ...values);
  const max = (rawMax > 0 ? rawMax : 1) * 1.15;

  ctx.font = '12px Arial, sans-serif';

  if (horizontal) {
    const barH = (h - p.top - p.bottom) / Math.max(1, values.length) * 0.58;
    values.forEach((v, i) => {
      const y = p.top + i * (h - p.top - p.bottom) / values.length + barH * 0.35;
      const bw = rawMax > 0 ? (w - p.left - p.right) * v / max : 0;
      ctx.fillStyle = colors.soft;
      ctx.fillRect(p.left, y, w - p.left - p.right, barH);
      ctx.fillStyle = i === values.length - 1 ? colors.danger : colors.green;
      ctx.fillRect(p.left, y, bw, barH);
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'right';
      ctx.fillText(labels[i] || '', p.left - 10, y + barH * 0.68);
      ctx.textAlign = 'left';
      ctx.fillText(fmtMoney.format(v), p.left + bw + 8, y + barH * 0.68);
    });
  } else {
    const gap = 14;
    const barW = (w - p.left - p.right - gap * Math.max(0, values.length - 1)) / Math.max(1, values.length);
    values.forEach((v, i) => {
      const bh = rawMax > 0 ? (h - p.top - p.bottom) * v / max : 0;
      const x = p.left + i * (barW + gap);
      const y = h - p.bottom - bh;
      ctx.fillStyle = colors.soft;
      ctx.fillRect(x, p.top, barW, h - p.top - p.bottom);
      ctx.fillStyle = colors.green;
      ctx.fillRect(x, y, barW, bh);
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'center';
      const label = labels[i] || '';
      ctx.fillText(label.length > 12 ? `${label.slice(0,10)}…` : label, x + barW / 2, h - 20);
      if (rawMax > 0 && v > 0) {
        ctx.fillStyle = colors.dark;
        ctx.font = 'bold 11px Arial, sans-serif';
        ctx.fillText(formatAxisMoney(v), x + barW / 2, Math.max(p.top + 14, y - 6));
        ctx.font = '12px Arial, sans-serif';
      }
    });
  }
}

function renderEvolution(){
  const data = evolutionData();
  const canvas = $('evolutionChart');
  if (!canvas) return;
  drawLineChart(canvas, data.labels, [{ data: data.values, color: colors.green, width: 4, point: 5 }]);
  canvas._evolutionTitles = data.titles;
  if ($('evolutionLegend')) {
    $('evolutionLegend').innerHTML = `<span><i style="background:${colors.green}"></i>Saldo ainda em aberto</span><span class="legend-note">Passe o mouse pelos pontos para ver os detalhes</span>`;
  }
}

function setupEvolutionInteraction(){
  const canvas = $('evolutionChart');
  const tooltip = $('evolutionTooltip');
  if (!canvas || !tooltip) return;

  canvas.addEventListener('mousemove', event => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const points = canvas._chartPoints || [];
    if (!points.length) {
      tooltip.hidden = true;
      return;
    }
    const nearest = points.reduce((best, point, index) => {
      const distance = Math.hypot(point.x - mx, point.y - my);
      return !best || distance < best.distance ? { point, index, distance } : best;
    }, null);

    if (!nearest || nearest.distance > 28) {
      tooltip.hidden = true;
      return;
    }
    const titles = canvas._evolutionTitles?.[nearest.index] || 0;
    tooltip.innerHTML = `<strong>${nearest.point.label}</strong><span>${fmtMoney.format(nearest.point.value)}</span><small>${titles} título${titles === 1 ? '' : 's'} ainda em aberto</small>`;
    tooltip.style.left = `${Math.min(rect.width - 190, Math.max(8, nearest.point.x + 12))}px`;
    tooltip.style.top = `${Math.max(8, nearest.point.y - 78)}px`;
    tooltip.hidden = false;
  });

  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
}

function renderFinancialHistory(){
  const data = financialHistoryData();
  const canvas = $('financialHistoryChart');
  if (!canvas) return;
  drawLineChart(canvas, data.labels, [
    { data: data.open, color: colors.dark, width: 4, point: 5 },
    { data: data.overdue, color: colors.green, width: 4, point: 5 }
  ]);
  canvas._financialData = data;
}

function setupFinancialInteraction(){
  const canvas = $('financialHistoryChart');
  const tooltip = $('financialHistoryTooltip');
  if (!canvas || !tooltip) return;

  canvas.addEventListener('mousemove', event => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const points = canvas._chartPoints || [];
    if (!points.length) {
      tooltip.hidden = true;
      return;
    }
    const nearest = points.reduce((best, point, index) => {
      const distance = Math.abs(point.x - mx);
      return !best || distance < best.distance ? { point, index, distance } : best;
    }, null);

    if (!nearest || nearest.distance > 35) {
      tooltip.hidden = true;
      return;
    }
    const data = canvas._financialData;
    tooltip.innerHTML = `<strong>${nearest.point.label}</strong><span>Total em aberto: ${fmtMoney.format(data.open[nearest.index])}</span><span>Total em atraso: ${fmtMoney.format(data.overdue[nearest.index])}</span>`;
    tooltip.style.left = `${Math.min(rect.width - 245, Math.max(8, nearest.point.x + 12))}px`;
    tooltip.style.top = '34px';
    tooltip.hidden = false;
  });

  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
}

function allRateData(){
  return selectedSnapshots().map(snapshot => {
    const all = filterRows(snapshot.allOpen || []);
    const ov = filterRows(snapshot.overdue || []);
    const totalOpen = sum(all.map(r => r.valor));
    const totalOverdue = sum(ov.map(r => r.valor));
    return { ...snapshot, totalOpen, totalOverdue, rate: totalOpen > 0 ? totalOverdue / totalOpen : 0 };
  }).filter(s => s.totalOpen > 0 || s.totalOverdue > 0);
}

function rateData(){
  return monthlySnapshots().map(snapshot => {
    const all = filterRows(snapshot.allOpen || []);
    const ov = filterRows(snapshot.overdue || []);
    const totalOpen = sum(all.map(r => r.valor));
    const totalOverdue = sum(ov.map(r => r.valor));
    return { ...snapshot, totalOpen, totalOverdue, rate: totalOpen > 0 ? totalOverdue / totalOpen : 0 };
  }).filter(s => s.totalOpen > 0 || s.totalOverdue > 0);
}

function setupRateInteraction(){
  const canvas = $('rateChart');
  const tooltip = $('rateTooltip');
  if (!canvas || !tooltip) return;

  canvas.addEventListener('mousemove', event => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const points = canvas._chartPoints || [];
    if (!points.length) {
      tooltip.hidden = true;
      return;
    }
    const nearest = points.reduce((best, point, index) => {
      const distance = Math.abs(point.x - mx);
      return !best || distance < best.distance ? { point, index, distance } : best;
    }, null);

    if (!nearest || nearest.distance > 35) {
      tooltip.hidden = true;
      return;
    }
    const data = canvas._rateData;
    const item = data?.[nearest.index];
    if (!item) {
      tooltip.hidden = true;
      return;
    }
    const fmt = v => new Intl.NumberFormat('pt-BR', { style:'percent', minimumFractionDigits:2, maximumFractionDigits:2 }).format(v);
    tooltip.innerHTML = `<strong>${nearest.point.label} (${showDate(item.date)})</strong><span>Taxa: ${fmt(item.rate)}</span><span>Total em atraso: ${fmtMoney.format(item.totalOverdue)}</span><span>Total em aberto: ${fmtMoney.format(item.totalOpen)}</span>`;
    tooltip.style.left = `${Math.min(rect.width - 250, Math.max(8, nearest.point.x + 12))}px`;
    tooltip.style.top = '34px';
    tooltip.hidden = false;
  });

  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
}

function renderRateChart(){
  const allData = allRateData();
  const data = rateData();
  const format = value => new Intl.NumberFormat('pt-BR', { style:'percent', minimumFractionDigits:2, maximumFractionDigits:2 }).format(value);
  const canvas = $('rateChart');
  if (!canvas) return;

  if (!allData.length || !data.length) {
    drawLineChart(canvas, ['Sem dados'], [{ data:[0], color:colors.green, width:4 }], { percent:true });
    $('rateCurrent').textContent = 'Atual: —';
    $('rateMax').textContent = '—';
    $('rateMin').textContent = '—';
    $('rateMaxDate').textContent = '—';
    $('rateMinDate').textContent = '—';
    return;
  }

  const max = allData.reduce((a,b) => b.rate > a.rate ? b : a);
  const min = allData.reduce((a,b) => b.rate < a.rate ? b : a);
  const current = allData.at(-1);

  const maxMonthKey = monthKey(max.date);
  const minMonthKey = monthKey(min.date);
  const maxIndex = data.findIndex(s => monthKey(s.date) === maxMonthKey);
  const minIndex = data.findIndex(s => monthKey(s.date) === minMonthKey);

  const pointColors = data.map((_,i) => i === maxIndex ? colors.danger : i === minIndex ? colors.dark : colors.green);
  const pointSizes = data.map((_,i) => i === maxIndex || i === minIndex ? 7 : 4);

  canvas._rateData = data;
  drawLineChart(canvas, data.map(s => monthLabel(monthKey(s.date))), [{ data: data.map(s => s.rate), color: colors.green, width: 4, pointColors, pointSizes }], { percent: true });
  $('rateCurrent').textContent = `Posição (${showDate(current.date)}): ${format(current.rate)}`;
  $('rateMax').textContent = format(max.rate);
  $('rateMaxDate').textContent = showDate(max.date);
  $('rateMin').textContent = format(min.rate);
  $('rateMinDate').textContent = showDate(min.date);
}

function renderKpis(){
  const rows = filteredTitles();
  const snapshots = selectedSnapshots();
  const latest = snapshots.at(-1);
  const allOpenFiltered = latest ? filterRows(latest.allOpen || []) : [];
  const sumAll = sum(allOpenFiltered.map(r => r.valor));
  const overdue = sum(rows.map(r => r.valor));
  const openTotal = sumAll > 0 ? sumAll : overdue;
  const crit = sum(rows.filter(r => Number(r.dias) > 90).map(r => r.valor));
  const clients = new Set(rows.map(r => r.cliente).filter(Boolean)).size;

  $('kpiSaldo').textContent = fmtMoney.format(openTotal);
  $('kpiIndice').textContent = fmtMoney.format(overdue);
  $('heroRisk').textContent = fmtMoney.format(overdue);
  $('kpiClientes').textContent = clients;
  $('kpi90').textContent = fmtMoney.format(crit);
  $('kpiSaldoDelta').textContent = `${allOpenFiltered.length || rows.length} títulos na carteira`;
  $('kpiIndiceDelta').textContent = `${rows.length} títulos inadimplentes`;
  $('kpiClientesDelta').textContent = 'Clientes com parcelas em atraso';
}

function renderInsights(){
  const rows = filteredTitles();
  const total = sum(rows.map(r => r.valor));
  const topClient = groupBy(rows, 'cliente')[0] || { key: '—', total: 0 };
  const maxDays = rows.reduce((m, r) => Math.max(m, Number(r.dias) || 0), 0);
  const criticalRows = rows.filter(r => Number(r.dias) > 90);
  const critical = criticalRows.length;
  const criticalBalance = sum(criticalRows.map(r => r.valor));

  $('trendText').textContent = `${critical} títulos acima de 90 dias`;
  $('peakText').textContent = `${maxDays} dias de atraso`;
  $('forecastText').textContent = fmtMoney.format(criticalBalance);
  $('riskText').textContent = topClient.key !== '—' ? `${topClient.key} • ${formatAxisMoney(topClient.total)}` : '—';
  $('executiveSummary').textContent = rows.length
    ? `A seleção soma ${fmtMoney.format(total)} em ${rows.length} títulos inadimplentes. A maior concentração de risco está no cliente ${topClient.key}, com aproximadamente ${formatAxisMoney(topClient.total)}.`
    : 'Nenhum título inadimplente encontrado para os filtros selecionados.';
}

function renderSecondaryCharts(){
  const rows = filteredTitles();
  const order = ['A vencer', '0-30', '31-60', '61-90', '+90'];
  const values = order.map(a => sum(rows.filter(r => r.aging === a).map(r => r.valor)));
  drawBarChart($('agingChart'), order, values, true);

  const vendors = groupBy(rows, 'gestor').slice(0, 6);
  const vendorLabels = vendors.length ? vendors.map(v => v.key.split(' ')[0]) : ['Nenhum'];
  const vendorValues = vendors.length ? vendors.map(v => v.total) : [0];
  drawBarChart($('regionChart'), vendorLabels, vendorValues, false);
}

function renderManagers(){
  const rows = filteredTitles();
  const items = groupBy(rows, 'gestor');
  const max = Math.max(1, ...items.map(x => x.total));
  const el = $('managerList');
  if (!el) return;
  el.innerHTML = items.length
    ? items.map(item => `
        <div class="manager-row">
          <div>
            <strong>${escapeHtml(item.key)}</strong>
            <small>${rows.filter(r => r.gestor === item.key).length} títulos em atraso</small>
            <div class="progress"><span style="width:${(item.total / max) * 100}%"></span></div>
          </div>
          <div class="amount">${fmtMoney.format(item.total)}</div>
        </div>
      `).join('')
    : '<div class="empty-state">Nenhum vendedor encontrado para os filtros selecionados.</div>';
}

function renderRanking(){
  const latestInfo = new Map();
  const latest = selectedSnapshots().at(-1);
  const el = $('rankingList');
  if (!el) return;

  if (!latest) {
    el.innerHTML = '<div class="empty-state">Nenhum cliente inadimplente registrado no período.</div>';
    return;
  }

  const rows = filterRows(latest.overdue || []).filter(r => Number(r.dias) > 0);
  const totals = groupBy(rows, 'cliente');
  rows.forEach(row => latestInfo.set(row.cliente, { codigo: row.codigo, gestor: row.gestor, date: latest.date }));

  const items = totals.sort((a,b) => b.total - a.total).slice(0, 5);
  el.innerHTML = items.length
    ? items.map((item, i) => {
        const info = latestInfo.get(item.key) || {};
        return `
          <div class="rank-row">
            <div>
              <strong>${i + 1}. ${escapeHtml(item.key)}</strong>
              <small>${escapeHtml(info.codigo || '')} • ${escapeHtml(info.gestor || '—')} • atualizado em ${showDate(info.date)}</small>
            </div>
            <div class="amount">${fmtMoney.format(item.total)}</div>
          </div>
        `;
      }).join('')
    : '<div class="empty-state">Nenhum cliente inadimplente registrado no período.</div>';
}

function cleanCnpj(value){
  return String(value || '').replace(/\D/g,'').slice(0,14);
}

function showCnpj(value){
  const cnpj = cleanCnpj(value);
  return cnpj.length === 14 ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : 'Não informado';
}

function financialRJClients(){
  const latest = selectedSnapshots().at(-1);
  const openRows = latest?.allOpen || state.allOpenRows;
  const rows = openRows.length ? openRows : (latest?.overdue || state.overdueRows);
  const clients = new Map();

  rows.forEach(row => {
    const key = normalizeHeader(row.cliente);
    const current = clients.get(key) || { cliente: row.cliente, cnpj: cleanCnpj(row.cnpj), total: 0, flagged: false };
    if (!current.cnpj) current.cnpj = cleanCnpj(row.cnpj);
    current.total += Number(row.valor) || 0;
    current.flagged = current.flagged || row.status === 'RECUPERAÇÃO JUDICIAL';
    clients.set(key, current);
  });
  return clients;
}

function rjMonitorItems(){
  const financial = financialRJClients();
  if (!state.customerRegistry.length) return [...financial.values()].sort((a,b) => b.total - a.total);
  const byCnpj = new Map([...financial.values()].filter(item => item.cnpj.length === 14).map(item => [item.cnpj, item]));
  return state.customerRegistry.map(customer => {
    const linked = byCnpj.get(customer.cnpj) || financial.get(normalizeHeader(customer.cliente));
    return { cliente: customer.cliente, cnpj: customer.cnpj, total: linked?.total || 0, flagged: linked?.flagged || false };
  }).filter(item => state.rjScope === 'all' || item.total > 0).sort((a,b) => b.total - a.total || a.cliente.localeCompare(b.cliente));
}

function formatQueryTime(count){
  if (!count) return '0 min';
  const minutes = Math.ceil(count / 5);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `≈ ${hours}h${rest ? ` ${rest}min` : ''}` : `≈ ${minutes} min`;
}

function updateRJEstimates(){
  const financial = [...financialRJClients().values()];
  const financialNames = new Set(financial.map(i => normalizeHeader(i.cliente)));
  const financialValid = new Set(financial.map(i => i.cnpj).filter(c => c.length === 14));

  if (state.customerRegistry.length) {
    state.customerRegistry.forEach(item => {
      if (financialNames.has(normalizeHeader(item.cliente)) && item.cnpj.length === 14) {
        financialValid.add(item.cnpj);
      }
    });
  }

  const allValid = new Set(state.customerRegistry.map(i => i.cnpj).filter(c => c.length === 14));
  $('rjFinancialEstimate').textContent = `${financialValid.size} CNPJs • ${formatQueryTime(financialValid.size)}`;
  $('rjFinancialEstimateDetail').textContent = 'Clientes com saldo em aberto na posição atual';
  $('rjAllEstimate').textContent = state.customerRegistry.length ? `${allValid.size} CNPJs • ${formatQueryTime(allValid.size)}` : 'Importe a planilha';
  $('rjAllEstimateDetail').textContent = state.customerRegistry.length ? 'Estimativa no limite de 5 consultas por minuto' : 'Limite de 5 consultas por minuto';
}

function renderRJMonitor(){
  const items = rjMonitorItems();
  const flagged = items.filter(i => i.flagged || state.rjChecks.get(i.cnpj)?.isRJ).length;
  const missing = items.filter(i => i.cnpj.length !== 14).length;
  const pending = items.filter(i => i.cnpj.length === 14 && !state.rjChecks.has(i.cnpj) && !i.flagged).length;

  updateRJEstimates();
  $('rjMonitorCount').textContent = `${items.length} cliente${items.length === 1 ? '' : 's'}`;
  $('rjFlaggedCount').textContent = flagged;
  $('rjPendingCount').textContent = pending;
  $('rjMissingCnpjCount').textContent = missing;

  $('rjMonitorTable').innerHTML = items.length
    ? items.map(item => {
        const check = state.rjChecks.get(item.cnpj);
        const loading = state.rjLoading.has(item.cnpj);
        const isRJ = item.flagged || check?.isRJ;
        const status = isRJ
          ? (check?.isRJ ? 'RJ identificada na Receita' : 'Sinalizado na planilha')
          : check?.specialStatus
            ? `Situação especial: ${check.specialStatus}`
            : check
              ? 'Sem RJ na situação especial'
              : 'Aguardando verificação';
        const badge = isRJ ? 'danger' : check?.error ? 'warn' : check ? 'ok' : 'warn';

        return `
          <tr>
            <td><strong>${escapeHtml(item.cliente)}</strong></td>
            <td>${showCnpj(item.cnpj)}</td>
            <td>${item.total > 0 ? fmtMoney.format(item.total) : 'Sem saldo em aberto'}</td>
            <td><span class="badge ${badge}">${escapeHtml(status)}</span>${check?.checkedAt ? `<small class="check-date">Consultado em ${escapeHtml(check.checkedAt)}</small>` : ''}</td>
            <td>
              ${item.cnpj.length === 14
                ? `<button class="official-search-link api-check-btn" type="button" data-cnpj="${item.cnpj}" ${loading ? 'disabled' : ''}>${loading ? 'Consultando…' : check ? 'Consultar novamente' : 'Consultar API'}</button><a class="cnj-secondary-link" href="https://consulta-datajud.cnj.jus.br/" target="_blank" rel="noopener noreferrer">CNJ ↗</a>`
                : '<span class="muted-text">CNPJ ausente ou inválido</span>'}
            </td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="5" class="empty-table">Nenhum cliente disponível neste critério.</td></tr>';
}

async function checkRJByCnpj(cnpj){
  if (state.rjLoading.has(cnpj)) return;
  state.rjLoading.add(cnpj);
  renderRJMonitor();
  try {
    const response = await fetch('/.netlify/functions/check-rj', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnpj })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Consulta indisponível.');
    state.rjChecks.set(cnpj, data);
  } catch (error) {
    state.rjChecks.set(cnpj, { isRJ: false, specialStatus: 'Falha na consulta', checkedAt: new Date().toLocaleString('pt-BR'), error: error.message });
  } finally {
    state.rjLoading.delete(cnpj);
    renderRJMonitor();
  }
}

async function checkAllRJ(){
  const button = $('checkAllRJBtn');
  const cnpjs = [...new Set(rjMonitorItems().map(item => item.cnpj).filter(cnpj => cnpj.length === 14 && !state.rjChecks.has(cnpj)))];

  if (!cnpjs.length) {
    button.textContent = 'Nenhuma consulta pendente';
    setTimeout(() => { button.textContent = 'Verificar clientes com CNPJ'; }, 1800);
    return;
  }

  button.disabled = true;
  for (let i = 0; i < cnpjs.length; i++) {
    button.textContent = `Consultando ${i + 1} de ${cnpjs.length}…`;
    await checkRJByCnpj(cnpjs[i]);
    if (i < cnpjs.length - 1) await new Promise(resolve => setTimeout(resolve, 12500));
  }
  button.disabled = false;
  button.textContent = 'Verificação concluída';
  setTimeout(() => { button.textContent = 'Verificar clientes com CNPJ'; }, 2200);
}

async function importCustomerRegistry(file){
  const workbook = XLSX.read(await file.arrayBuffer(), { type:'array', cellDates:true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });
  let headerRow = -1, cnpjColumn = -1, nameColumn = -1, codeColumn = -1;

  for (let i = 0; i < Math.min(matrix.length, 30); i++) {
    const headers = matrix[i].map(normalizeHeader);
    const cnpj = headers.findIndex(h => ['cnpj','cpf/cnpj','cpf cnpj','documento fiscal','doc fiscal'].includes(h));
    const name = headers.findIndex(h => ['nome do pn','nome do cliente','razao social','razão social','cliente','nome'].includes(h));
    if (cnpj >= 0 && name >= 0) {
      headerRow = i;
      cnpjColumn = cnpj;
      nameColumn = name;
      codeColumn = headers.findIndex(h => ['codigo do pn','codigo pn','codigo','cod'].includes(h));
      break;
    }
  }

  if (headerRow < 0) throw new Error('Não foi possível identificar as colunas de Nome do Cliente e CNPJ.');
  const unique = new Map();

  matrix.slice(headerRow + 1).forEach(row => {
    const cliente = String(row[nameColumn] || '').trim();
    const cnpj = cleanCnpj(row[cnpjColumn]);
    const codigo = codeColumn >= 0 ? String(row[codeColumn] || '').trim() : '';
    if (!cliente) return;
    const key = cnpj.length === 14 ? `cnpj:${cnpj}` : `nome:${normalizeHeader(cliente)}`;
    if (!unique.has(key)) unique.set(key, { cliente, cnpj, codigo });
  });

  state.customerRegistry = [...unique.values()];
  const valid = new Set(state.customerRegistry.map(item => item.cnpj).filter(cnpj => cnpj.length === 14));
  $('rjRegistryStatus').textContent = `${file.name}: ${state.customerRegistry.length} clientes, ${valid.size} CNPJs válidos e únicos.`;
  renderRJMonitor();
}

function renderTable(){
  const rows = historicalFilteredTitles();
  $('rowCount').textContent = `${rows.length} registro${rows.length === 1 ? '' : 's'}`;
  const el = $('detailTable');
  if (!el) return;
  el.innerHTML = rows.length
    ? rows.map(r => `
        <tr title="${escapeHtml(r.observacoes || '')}">
          <td><strong>${escapeHtml(r.cliente)}</strong></td>
          <td>${escapeHtml(r.codigo || '—')}</td>
          <td>${escapeHtml(r.gestor || '—')}</td>
          <td>${escapeHtml(r.documento || '—')}</td>
          <td>${escapeHtml(r.nf || '—')}</td>
          <td>${showDate(r.vencimento)}</td>
          <td>${r.aging}</td>
          <td>${r.dias}</td>
          <td>${fmtMoneyFull.format(r.valor)}</td>
          <td><span class="badge ${r.status === 'RECUPERAÇÃO JUDICIAL' ? 'danger' : r.status === 'EM ATRASO' ? 'warn' : 'ok'}">${r.status}</span></td>
        </tr>
      `).join('')
    : '<tr><td colspan="10" class="empty-table">Nenhum título encontrado para os filtros selecionados.</td></tr>';
}

function renderAll(){
  renderKpis();
  renderFinancialHistory();
  renderEvolution();
  renderRateChart();
  renderInsights();
  renderSecondaryCharts();
  renderManagers();
  renderRanking();
  renderRJMonitor();
  renderTable();
  renderPaymentHistory();
}

function resetFilters(){
  ['clienteFilter','gestorFilter','statusFilter'].forEach(id => {
    const el = $(id);
    if (el) el.value = 'Todos';
  });
  if ($('periodoFilter')) $('periodoFilter').value = '12';
  if ($('globalSearch')) $('globalSearch').value = '';
  state.selectedYears = new Set();
  const all = $('yearOptions')?.querySelector('[data-all]');
  if (all) all.checked = true;
  [...($('yearOptions')?.querySelectorAll('input:not([data-all])') || [])].forEach(input => { input.checked = false; });
  updateYearSummary();
  renderAll();
}

function exportCsv(){
  const rows = historicalFilteredTitles();
  const header = importFields.map(f => f.label);
  const csv = [
    header.join(';'),
    ...rows.map(r => importFields.map(f => String(r[f.key] ?? '').replace(/;/g, ',')).join(';'))
  ].join('\n');

  const blob = new Blob([`\uFEFF${csv}`], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'inadimplentes_filtrados.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function mapSheetRows(rawRows){
  if (!rawRows.length) throw new Error('A aba da planilha não possui registros.');
  const headers = Object.keys(rawRows[0]);
  const map = {};
  importFields.forEach(f => {
    const match = headers.find(h => f.aliases.map(normalizeHeader).includes(normalizeHeader(h)));
    if (match) map[f.key] = match;
  });

  const required = ['cliente', 'valor', 'dias', 'gestor'];
  const missing = required.filter(k => !map[k]).map(k => importFields.find(f => f.key === k).label);
  if (missing.length) throw new Error(`Colunas obrigatórias não encontradas: ${missing.join(', ')}.`);

  return rawRows.map((row, index) => ({
    codigo: String(row[map.codigo] || '').trim(),
    cnpj: String(row[map.cnpj] || '').trim(),
    cliente: String(row[map.cliente] || '').trim(),
    documento: String(row[map.documento] || '').trim(),
    nf: String(row[map.nf] || '').trim(),
    emissao: toIsoDate(row[map.emissao]),
    vencimento: toIsoDate(row[map.vencimento]),
    valor: parseMoney(row[map.valor]),
    dias: Number(row[map.dias]),
    observacoes: String(row[map.observacoes] || '').trim(),
    gestor: String(row[map.gestor] || '').trim(),
    _row: index + 2
  })).filter(r => r.cliente);
}

function getHeaderRowIndex(sheet, isAnalysis = false) {
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
    const cols = rawRows[i].map(c => normalizeHeader(String(c)));
    if (isAnalysis) {
      if (cols.some(c => c === 'razao social' || c === 'cliente')) return i;
    } else {
      const hasCliente = cols.some(c => importFields.find(f => f.key === 'cliente').aliases.map(normalizeHeader).includes(c));
      const hasValor = cols.some(c => importFields.find(f => f.key === 'valor').aliases.map(normalizeHeader).includes(c));
      if (hasCliente && hasValor) return i;
    }
  }
  return 0;
}

function analysisFromWorkbook(workbook){
  const name = workbook.SheetNames.find(n => {
    const norm = normalizeHeader(n);
    return norm.includes('analise') || (norm.includes('inadimpl') && !norm.includes('total'));
  });
  if (!name) return {};
  const sheet = workbook.Sheets[name];
  const headerRow = getHeaderRowIndex(sheet, true);
  const rows = XLSX.utils.sheet_to_json(sheet, { range: headerRow, defval: '' });
  const map = {};
  rows.forEach(row => {
    const keys = Object.keys(row);
    const get = label => row[keys.find(k => normalizeHeader(k) === normalizeHeader(label))] || '';
    const cliente = String(get('Razão Social') || get('Razao Social') || get('Cliente') || get('Rótulos de Linha') || get('Rótulo de Linha') || get('CLIENTES') || '').trim();
    if (cliente && !normalizeHeader(cliente).startsWith('total') && !normalizeHeader(cliente).startsWith('geral')) {
      map[cliente] = {
        gestorAnalise: String(get('VENDEDOR') || get('Vendedor')).trim(),
        cobranca: String(get('STATUS DA COBRANÇA') || get('STATUS') || '').trim(),
        negociacao: String(get('NEGOCIAÇÃO') || get('GARANTIAS') || '').trim(),
        providencia: String(get('PROVIDENCIA')).trim()
      };
    }
  });
  return map;
}

function findSheet(workbook, term){
  const normTerm = normalizeHeader(term);
  return workbook.SheetNames.find(name => normalizeHeader(name).includes(normTerm));
}

function renderImportPreview(rows){
  $('previewHead').innerHTML = `<tr>${importFields.map(f => `<th>${f.label}</th>`).join('')}</tr>`;
  $('previewBody').innerHTML = rows.slice(0, 5).map(row => `
    <tr>${importFields.map(f => `<td>${f.key === 'valor' ? fmtMoneyFull.format(row[f.key]) : escapeHtml(f.key === 'vencimento' || f.key === 'emissao' ? showDate(row[f.key]) : row[f.key])}</td>`).join('')}</tr>
  `).join('');
}

function clearImport(){
  state.pendingImport = null;
  $('fileInput').value = '';
  $('importFeedback').hidden = true;
  $('previewWrap').hidden = true;
  $('validationMessage').className = 'validation-message';
}

function showImportError(message){
  state.pendingImport = null;
  $('validationMessage').className = 'validation-message error';
  $('validationMessage').textContent = message;
  $('previewWrap').hidden = true;
}

const monthsNameMap = {
  'janeiro': '01', 'jan': '01',
  'fevereiro': '02', 'fev': '02',
  'marco': '03', 'março': '03', 'mar': '03',
  'abril': '04', 'abr': '04',
  'maio': '05', 'mai': '05',
  'junho': '06', 'jun': '06',
  'julho': '07', 'jul': '07',
  'agosto': '08', 'ago': '08',
  'setembro': '09', 'set': '09',
  'outubro': '10', 'out': '10',
  'novembro': '11', 'nov': '11',
  'dezembro': '12', 'dez': '12'
};

function snapshotDate(file){
  const source = `${file.webkitRelativePath || ''} ${file.name}`;
  const cleanSource = normalizeHeader(source);

  // 1. DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY, DD_MM_YYYY (ex: "CONTROLE DE INADIMPLENCIA 25.08.2026.xlsx")
  let m = source.match(/(?:^|[^\d])(\d{1,2})[.\/_\-](\d{1,2})[.\/_\-](\d{4})(?:[^\d]|$)/);
  if (m) {
    const d = m[1].padStart(2, '0'), month = m[2].padStart(2, '0'), y = m[3];
    if (Number(month) >= 1 && Number(month) <= 12 && Number(d) >= 1 && Number(d) <= 31 && Number(y) >= 2000 && Number(y) <= 2035) {
      return `${y}-${month}-${d}`;
    }
  }

  // 2. YYYY-MM-DD / YYYY.MM.DD / YYYY_MM_DD
  m = source.match(/(?:^|[^\d])(\d{4})[.\/_\-](\d{1,2})[.\/_\-](\d{1,2})(?:[^\d]|$)/);
  if (m) {
    const y = m[1], month = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
    if (Number(month) >= 1 && Number(month) <= 12 && Number(d) >= 1 && Number(d) <= 31 && Number(y) >= 2000 && Number(y) <= 2035) {
      return `${y}-${month}-${d}`;
    }
  }

  // 3. 8 dígitos sem separador: DDMMAAAA (ex: "CONTROLE DE INADIMPLENCIA 25082026.xlsx")
  m = source.match(/(?:^|[^\d])(\d{2})(\d{2})(\d{4})(?:[^\d]|$)/);
  if (m) {
    const d = m[1], month = m[2], y = m[3];
    if (Number(month) >= 1 && Number(month) <= 12 && Number(d) >= 1 && Number(d) <= 31 && Number(y) >= 2000 && Number(y) <= 2035) {
      return `${y}-${month}-${d}`;
    }
  }

  // 4. 7 dígitos sem separador: DMMYYYY (ex: "1102023" -> dia 01, mês 10, ano 2023)
  m = source.match(/(?:^|[^\d])(\d{1,2})(\d{2})(\d{4})(?:[^\d]|$)/);
  if (m) {
    const d = m[1].padStart(2, '0'), month = m[2], y = m[3];
    if (Number(month) >= 1 && Number(month) <= 12 && Number(d) >= 1 && Number(d) <= 31 && Number(y) >= 2000 && Number(y) <= 2035) {
      return `${y}-${month}-${d}`;
    }
  }

  // 5. Extração por pasta de mês/ano + dia no nome
  const yearMatch = source.match(/\b(202\d)\b/);
  let foundMonth = null;
  for (const [mName, mNum] of Object.entries(monthsNameMap)) {
    if (cleanSource.includes(mName)) { foundMonth = mNum; break; }
  }
  const dayMatch = file.name.match(/(?:^|[^\d])(\d{1,2})(?:[^\d]|$)/);
  if (yearMatch && foundMonth && dayMatch) {
    const d = dayMatch[1].padStart(2, '0');
    if (Number(d) >= 1 && Number(d) <= 31) {
      return `${yearMatch[1]}-${foundMonth}-${d}`;
    }
  }

  return '1970-01-01';
}

async function parseSnapshot(file){
  const workbook = XLSX.read(await file.arrayBuffer(), { type:'array', cellDates:true });
  const analysis = analysisFromWorkbook(workbook);
  const overdueName = workbook.SheetNames.find(s => {
    const norm = normalizeHeader(s);
    return norm.includes('total inadimplent') || norm.includes('total inaidmplent') || norm.includes('total inadimplenc') || norm.includes('inadimplentes') || (norm.includes('inadimplencia') && !norm.includes('analise'));
  }) || workbook.SheetNames[0];

  const openName = workbook.SheetNames.find(s => {
    const norm = normalizeHeader(s);
    return norm.includes('total em aberto') || norm.includes('em aberto');
  });
  
  const overdueSheet = workbook.Sheets[overdueName];
  const overdueRange = getHeaderRowIndex(overdueSheet);
  const overdue = mapSheetRows(XLSX.utils.sheet_to_json(overdueSheet, { range: overdueRange, defval:'' })).map(r => enrichRow(r, analysis));
  
  let allOpen = [];
  if (openName) {
    const openSheet = workbook.Sheets[openName];
    const openRange = getHeaderRowIndex(openSheet);
    allOpen = mapSheetRows(XLSX.utils.sheet_to_json(openSheet, { range: openRange, defval:'' })).map(r => enrichRow(r, analysis));
  }
  const invalid = overdue.find(r => !Number.isFinite(r.valor) || !Number.isFinite(r.dias));

  if (invalid) throw new Error(`Valor ou dias inválidos na linha ${invalid._row}.`);
  return {
    date: snapshotDate(file),
    file: file.name,
    path: file.webkitRelativePath || file.name,
    lastModified: file.lastModified,
    hasOpenSheet: Boolean(openName),
    allOpen,
    overdue,
    analysis,
    totalOpen: sum(allOpen.map(r => r.valor)),
    totalOverdue: sum(overdue.map(r => r.valor)),
    titles: overdue.length,
    clients: new Set(overdue.map(r => r.cliente)).size,
    critical: sum(overdue.filter(r => r.dias > 90).map(r => r.valor))
  };
}

function repairMissingOpenBalances(history){
  const valid = history.filter(s => s.allOpen?.length && s.totalOpen > s.totalOverdue * 1.05);
  history.forEach(snapshot => {
    const suspicious = !snapshot.allOpen?.length || snapshot.totalOpen <= snapshot.totalOverdue * 1.0001;
    if (!suspicious || !valid.length) return;
    const targetTime = new Date(`${snapshot.date}T12:00:00`).getTime();
    const nearest = valid.reduce((best, item) => {
      const bestDist = Math.abs(new Date(`${best.date}T12:00:00`).getTime() - targetTime);
      const itemDist = Math.abs(new Date(`${item.date}T12:00:00`).getTime() - targetTime);
      return itemDist < bestDist ? item : best;
    });
    snapshot.allOpen = nearest.allOpen;
    snapshot.totalOpen = nearest.totalOpen;
    snapshot.openBalanceSource = `posição de ${nearest.date}`;
  });
  return history;
}

async function handleImportFiles(fileList){
  const files = [...fileList].filter(f => /\.(xlsx|xls|csv)$/i.test(f.name) && !f.name.startsWith('~$'));
  $('importFeedback').hidden = false;
  $('previewWrap').hidden = true;
  $('fileName').textContent = files.length === 1 ? files[0].name : `${files.length} arquivos encontrados`;
  $('fileMeta').textContent = 'Preparando compilação...';
  $('validationMessage').className = 'validation-message loading';

  if (!files.length) {
    showImportError('Nenhuma planilha Excel ou CSV foi encontrada na seleção.');
    return;
  }

  const results = [];
  const errors = [];
  let cursor = 0, done = 0;

  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      try {
        results.push(await parseSnapshot(file));
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
      done++;
      $('validationMessage').textContent = `Processando ${done} de ${files.length} arquivos...`;
    }
  };

  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));

  if (!results.length) {
    showImportError(errors[0] || 'Nenhum arquivo válido pôde ser processado.');
    return;
  }

  const byDate = new Map();
  results.sort((a,b) => a.date.localeCompare(b.date) || a.lastModified - b.lastModified).forEach(s => byDate.set(s.date, s));
  const history = repairMissingOpenBalances([...byDate.values()].sort((a,b) => a.date.localeCompare(b.date)));
  const latest = history.at(-1);

  state.pendingImport = {
    allOpen: latest.allOpen,
    overdue: latest.overdue,
    analysis: latest.analysis,
    sourceFile: latest.file,
    history
  };

  $('fileName').textContent = `${history.length} snapshots consolidados`;
  $('fileMeta').textContent = `${files.length} arquivos lidos • ${monthLabel(monthKey(history[0].date))} a ${monthLabel(monthKey(latest.date))}`;
  $('validationMessage').className = 'validation-message success';
  const repaired = history.filter(s => s.openBalanceSource).length;
  $('validationMessage').textContent = `Histórico pronto. O arquivo de ${showDate(latest.date)} será usado como posição atual${repaired ? `; ${repaired} posição(ões) sem total em aberto foram associadas à base mais próxima` : ''}${errors.length ? `; ${errors.length} arquivo(s) com formato não compatível ignorado(s)` : ''}.`;
  renderImportPreview(latest.overdue);
  $('previewWrap').hidden = false;
}

function applyImport(){
  if (!state.pendingImport) return;
  state.allOpenRows = state.pendingImport.allOpen;
  state.overdueRows = state.pendingImport.overdue;
  state.analysis = state.pendingImport.analysis;
  state.history = state.pendingImport.history;
  state.sourceFile = state.pendingImport.sourceFile;
  state.updatedAt = state.history.at(-1).date;
  state.pendingImport = null;
  state._paymentHistoryCache = null;

  $('baseUpdated').textContent = `Base atual: ${state.sourceFile} • histórico de ${state.history.length} snapshots`;
  refreshFilters();
  refreshYearFilter();
  resetFilters();
  $('validationMessage').className = 'validation-message success';
  $('validationMessage').textContent = 'Histórico consolidado com sucesso no navegador.';
  $('previewWrap').hidden = true;
  document.querySelector('#visao')?.scrollIntoView({ behavior:'smooth' });
}

function downloadTemplate(){
  const header = importFields.map(f => f.label).join(';');
  const sample = ['CL00001','00123456000199','CLIENTE EXEMPLO LTDA','12345','45678','24/08/2026','24/07/2026','78500,00','31','Contato em andamento','VENDEDOR EXEMPLO'].join(';');
  const blob = new Blob([`\uFEFF${header}\n${sample}`], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modelo_total_inadimplentes.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function loadInitialData(){
  const base = window.BASE_INADIMPLENCIA || {};
  state.analysis = base.analise || {};
  state.allOpenRows = (base.totalEmAberto || []).map(r => enrichRow(r, state.analysis));
  state.overdueRows = (base.inadimplentes || []).map(r => enrichRow(r, state.analysis));
  state.sourceFile = base.sourceFile || 'Base inicial';
  state.updatedAt = base.updatedAt || '';

  const match = String(state.updatedAt).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const date = match ? `${match[3]}-${match[2]}-${match[1]}` : new Date().toISOString().slice(0,10);
  state.history = [{
    date,
    file: state.sourceFile,
    allOpen: state.allOpenRows,
    overdue: state.overdueRows,
    totalOpen: sum(state.allOpenRows.map(r => r.valor)),
    totalOverdue: sum(state.overdueRows.map(r => r.valor)),
    titles: state.overdueRows.length,
    clients: new Set(state.overdueRows.map(r => r.cliente)).size
  }];
  $('baseUpdated').textContent = `Base: ${state.sourceFile}${state.updatedAt ? ` • ${state.updatedAt}` : ''}`;
}

async function parsePaymentSpreadsheet(file) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  
  if (!rawRows.length) throw new Error('A planilha está vazia.');
  
  let headerRow = 0;
  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const cols = rawRows[i].map(c => normalizeHeader(String(c)));
    if (cols.includes('customer') || cols.includes('name') || cols.includes('payment date')) {
      headerRow = i; break;
    }
  }
  
  const headers = rawRows[headerRow].map(c => normalizeHeader(String(c)));
  const findCol = (...names) => headers.findIndex(h => names.includes(h));
  
  const colCustomer = findCol('customer', 'código', 'codigo do cliente', 'codigo');
  const colName = findCol('name', 'nome', 'nome do cliente', 'razao social', 'cliente');
  const colSap = findCol('sap number', 'sap', 'nº sap', 'no sap');
  const colInvoice = findCol('invoice number', 'invoice', 'nota fiscal', 'nf');
  const colIssue = findCol('invoice date', 'data de emissão', 'emissao');
  const colDue = findCol('due date', 'data de vencimento', 'vencimento');
  const colPay = findCol('payment date', 'data do pagamento efetivo', 'pagamento');
  const colVal = findCol('invoice value', 'valor da nota', 'valor');

  const parsed = [];
  rawRows.slice(headerRow + 1).forEach((row) => {
    const name = String(row[colName] || '').trim();
    if (!name) return;
    
    const dueDate = toIsoDate(row[colDue]);
    const payDate = toIsoDate(row[colPay]);
    const value = parseMoney(row[colVal]);
    
    if (!dueDate || !payDate || isNaN(value)) return;
    
    const delay = Math.round((new Date(payDate) - new Date(dueDate)) / (1000 * 60 * 60 * 24));
    let status = 'No Prazo';
    if (delay > 0) status = 'Atrasado';
    else if (delay < 0) status = 'Adiantado';
    
    parsed.push({
      customer: String(row[colCustomer] || '').trim(),
      name,
      sap: String(row[colSap] || '').trim(),
      invoice: String(row[colInvoice] || '').trim(),
      issueDate: toIsoDate(row[colIssue]),
      dueDate,
      payDate,
      value,
      delay,
      status
    });
  });
  
  state.paymentBase = parsed.sort((a,b) => a.payDate.localeCompare(b.payDate));
  renderAll();
}


function renderPaymentHistory() {
  const f = currentFilters();
  const search = f.search;
  
  let rows = state.paymentBase;
  if (search) {
    rows = rows.filter(r => {
      const name = r.name.toLowerCase();
      const customer = r.customer.toLowerCase();
      return name.includes(search) || customer.includes(search);
    });
  } else if (f.cliente !== 'Todos') {
    rows = rows.filter(r => r.name.toLowerCase() === f.cliente.toLowerCase());
  }
  
  const timeline = document.getElementById('paymentTimeline');
  if (timeline) {
    timeline.configure({
      backgroundImage: "./assets/fundo-agro-limpo.png"
    });
    const mapped = rows.map((pt, i) => ({
      id: i,
      client: pt.name,
      dueDate: pt.dueDate,
      paymentDate: pt.payDate,
      amount: pt.value,
      daysDelay: pt.delay
    }));
    timeline.data = mapped;
  }
  
  const tbody = $('paymentDetailTable');
  if (tbody) {
    const sorted = [...rows].sort((a,b) => b.delay - a.delay);
    tbody.innerHTML = sorted.length 
      ? sorted.slice(0, 100).map(r => `
          <tr>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td>${escapeHtml(r.sap || '—')}</td>
            <td>${escapeHtml(r.invoice || '—')}</td>
            <td>${showDate(r.issueDate)}</td>
            <td>${showDate(r.dueDate)}</td>
            <td>${showDate(r.payDate)}</td>
            <td><span class="badge ${r.delay > 0 ? 'danger' : 'ok'}">${r.status}</span></td>
            <td>${r.delay > 0 ? `+${r.delay}` : r.delay}</td>
            <td>${fmtMoney.format(r.value)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="9" class="empty-table">Nenhum título importado ou cliente não encontrado na base de pagamentos.</td></tr>';
  }
}

async function init(){
  // Verificação de autenticação Supabase
  if (window.appSupabase) {
    
    const hashData = window.location.hash.substring(1);
    if (hashData.startsWith('session=')) {
      try {
        const sessionStr = decodeURIComponent(hashData.split('=')[1]);
        const sessionData = JSON.parse(sessionStr);
        await window.appSupabase.auth.setSession({
          access_token: sessionData.access_token,
          refresh_token: sessionData.refresh_token
        });
        window.history.replaceState(null, null, ' ');
      } catch(e) { console.error("Erro sessão hash", e); }
    }

    const { data } = await window.appSupabase.auth.getSession();
    if (!data.session) {
      window.location.href = 'login.html';
      return;
    }
    document.body.classList.add('auth-checked');

    // CARREGA DADOS DO BANCO DE DADOS
    await fetchDatabaseHistory();

  } else if (sessionStorage.getItem('compo_auth') !== 'true') {
     window.location.href = 'login.html';
     return;
  }
  
  refreshFilters();
  refreshYearFilter();

  ['clienteFilter','gestorFilter','statusFilter','periodoFilter'].forEach(id => {
    $(id)?.addEventListener('change', renderAll);
  });
  $('globalSearch')?.addEventListener('input', renderAll);
  $('resetBtn')?.addEventListener('click', resetFilters);
  $('exportBtn')?.addEventListener('click', exportCsv);
  $('templateBtn')?.addEventListener('click', downloadTemplate);

  // Limpar os event listeners antigos que não estão mais no HTML
  // (já removemos do index.html a DIV com o id="dropZone")
  
  $('cloudSyncBtn')?.addEventListener('click', async () => {
    if (!window.appSupabase) {
      alert("Conexão com a nuvem não estabelecida.");
      return;
    }
    const btn = $('cloudSyncBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Baixando do Cofre Privado...';
    btn.disabled = true;

    try {
      // Faz o download do arquivo mestre.xlsx do bucket 'arquivos-mestre'
      const { data, error } = await window.appSupabase.storage.from('arquivos-mestre').download('mestre.xlsx');
      
      if (error) throw error;
      
      // Simula a injeção do arquivo como se tivesse sido upado
      const file = new File([data], "mestre.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      handleImportFiles([file]);
      
      btn.innerHTML = '✅ Sincronizado com Sucesso';
      setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 3000);
      
    } catch (e) {
      console.error(e);
      alert("Erro ao baixar o arquivo mestre: " + e.message + "\n\n(Certifique-se de que fez o upload do arquivo 'mestre.xlsx' no bucket 'arquivos-mestre' no painel)");
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  });

  $('importCustomerRegistryBtn')?.addEventListener('click', () => $('customerRegistryInput')?.click());
  $('customerRegistryInput')?.addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    $('rjRegistryStatus').textContent = 'Lendo e cruzando a planilha…';
    try {
      await importCustomerRegistry(file);
    } catch (error) {
      $('rjRegistryStatus').textContent = `Não foi possível importar: ${error.message}`;
    } finally {
      event.target.value = '';
    }
  });

  $('rjScopeSelect')?.addEventListener('change', event => {
    state.rjScope = event.target.value;
    renderRJMonitor();
  });

  $('checkAllRJBtn')?.addEventListener('click', checkAllRJ);
  $('rjMonitorTable')?.addEventListener('click', event => {
    const button = event.target.closest('.api-check-btn');
    if (button) checkRJByCnpj(button.dataset.cnpj);
  });

  // Close year options dropdown when clicking outside
  document.addEventListener('click', event => {
    const yearDetails = $('yearFilter');
    if (yearDetails && yearDetails.open && !yearDetails.contains(event.target)) {
      yearDetails.removeAttribute('open');
    }
  });

  const navLinks = document.querySelectorAll('#mainNav a');
  const tabs = document.querySelectorAll('.tab-pane');
  
  navLinks.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navLinks.forEach(l => l.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));
      link.classList.add('active');
      const targetId = link.getAttribute('href').substring(1);
      const targetTab = $(targetId);
      if (targetTab) {
        targetTab.classList.add('active');
        // Re-render charts to fix canvas sizes when showing previously hidden tabs
        requestAnimationFrame(() => {
          renderAll();
          setTimeout(() => renderAll(), 60);
        });
      }
    });
  });

  setupFinancialInteraction();
  setupEvolutionInteraction();
  setupRateInteraction();
  $('paymentHistoryImportBtn')?.addEventListener('click', () => $('paymentHistoryInput')?.click());
  $('paymentHistoryInput')?.addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await parsePaymentSpreadsheet(file);
    } catch (e) {
      alert('Erro na importação: ' + e.message);
    } finally {
      event.target.value = '';
    }
  });

  $('paymentHistoryMockBtn')?.addEventListener('click', () => {
    const mock = [];
    const baseDate = new Date();
    for (let i=0; i<400; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() - Math.floor(Math.random() * 730)); // 2 years back
      const pay = new Date(d);
      const isLate = Math.random() > 0.6;
      const delay = isLate ? Math.floor(Math.random() * 90) + 1 : -Math.floor(Math.random() * 5);
      pay.setDate(pay.getDate() + delay);
      
      mock.push({
        customer: 'C001',
        name: 'AGRO FORTTE EXEMPLO',
        sap: '12345',
        invoice: `NF-${1000+i}`,
        issueDate: toIsoDate(new Date(d.getTime() - 86400000*30)),
        dueDate: toIsoDate(d),
        payDate: toIsoDate(pay),
        value: 1000 + Math.random()*50000,
        delay,
        status: delay > 0 ? 'Atrasado' : delay === 0 ? 'No Prazo' : 'Adiantado'
      });
    }
    state.paymentBase = mock.sort((a,b) => a.payDate.localeCompare(b.payDate));
    if ($('globalSearch')) $('globalSearch').value = 'AGRO FORTTE';
    renderAll();
  });
  

  
  window.addEventListener('resize', renderAll);
  renderAll();

  // Importação de pastas e arquivos avulsos, sem modificar o parser.
  const dbUploadBtn = $('dbUploadBtn');
  const dbClearBtn = $('dbClearBtn');
  const folderInput = $('dbFileInput');
  const singleInput = $('dbSingleFileInput');
  folderInput.addEventListener('change', () => { if (folderInput.files.length) singleInput.value = ''; });
  singleInput.addEventListener('change', () => { if (singleInput.files.length) folderInput.value = ''; });
  if (dbUploadBtn) {
    dbUploadBtn.addEventListener('click', async () => {
      const files = [...(folderInput.files.length ? folderInput.files : singleInput.files)]
        .filter(f => /\.(xlsx|xls|csv)$/i.test(f.name) && !f.name.startsWith('~$'));
      if (!files.length) return alert('Selecione uma pasta ou planilhas válidas.');
      if (!window.appSupabase) return alert('Conexão Supabase indisponível.');
      const status = $('dbUploadStatus');
      const manualDate = $('dbDateInput').value;
      const warnings = [];
      const snapshots = new Map();
      let saved = 0, skipped = 0;
      dbUploadBtn.disabled = true;
      folderInput.disabled = true;
      singleInput.disabled = true;
      const formatRows = (rows, date) => rows.map(r => ({
        data_base: date, codigo: r.codigo, cnpj: r.cnpj, cliente: r.cliente,
        documento: r.documento, nf: r.nf, emissao: r.emissao || null,
        vencimento: r.vencimento || null, valor: r.valor, dias: r.dias,
        observacoes: r.observacoes, gestor: r.gestor
      }));
      const send = async (table, rows) => {
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await window.appSupabase.from(table).insert(rows.slice(i, i + 500));
          if (error) throw new Error(table + ': ' + error.message);
        }
      };
      const exists = async date => {
        for (const table of ['inadimplencia_history', 'carteira_history']) {
          const { data, error } = await window.appSupabase.from(table)
            .select('id').eq('data_base', date).limit(1);
          if (error) throw error;
          if (data.length) return true;
        }
        return false;
      };
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          status.textContent = 'Processando ' + (i + 1) + '/' + files.length + ': ' + file.name;
          try {
            const snapshot = await parseSnapshot(file);
            if (snapshot.date === '1970-01-01') {
              if (files.length === 1 && manualDate) snapshot.date = manualDate;
              else throw new Error('Data ausente no nome/caminho');
            }
            if (snapshots.has(snapshot.date)) {
              warnings.push(file.name + ': data repetida na seleção (' + snapshot.date + ')');
              continue;
            }
            snapshots.set(snapshot.date, snapshot);
          } catch (err) {
            warnings.push(file.name + ': ' + err.message);
          }
        }
        if (!snapshots.size) throw new Error('Nenhum snapshot com data reconhecida.');
        if (!confirm('Importar ' + snapshots.size + ' datas? Datas já presentes no banco serão ignoradas.')) {
          status.textContent = 'Importação cancelada antes do envio.';
          return;
        }
        const ordered = [...snapshots.values()].sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 0; i < ordered.length; i++) {
          const snap = ordered[i];
          status.textContent = 'Enviando ' + (i + 1) + '/' + ordered.length + ': ' + snap.date;
          try {
            if (await exists(snap.date)) { skipped++; continue; }
            const overdue = formatRows(snap.overdue, snap.date);
            const carteira = formatRows(snap.allOpen, snap.date);
            if (!overdue.length && !carteira.length) {
              warnings.push(snap.file + ': nenhuma linha válida');
              continue;
            }
            await send('inadimplencia_history', overdue);
            await send('carteira_history', carteira);
            saved++;
          } catch (err) {
            warnings.push(snap.file + ' (' + snap.date + '): ' + err.message + ' — verifique carga parcial antes de tentar novamente');
          }
        }
        if (saved && window.idbKeyval) {
          for (const key of ['inadimplencia_cache_v2', 'carteira_cache_v1']) {
            try { await idbKeyval.del(key); } catch (err) { console.warn(err); }
          }
        }
        status.textContent = 'Carga concluída: ' + saved + ' datas salvas, ' + skipped +
          ' existentes ignoradas, ' + warnings.length + ' avisos.';
        if (warnings.length) {
          console.warn('Importação:', warnings);
          alert('Avisos da carga:\n' + warnings.slice(0, 10).join('\n'));
        }
        if (saved) await fetchDatabaseHistory();
        if (!warnings.length) { folderInput.value = ''; singleInput.value = ''; }
      } catch (err) {
        console.error(err);
        status.textContent = 'Erro: ' + err.message;
      } finally {
        dbUploadBtn.disabled = false;
        folderInput.disabled = false;
        singleInput.disabled = false;
      }
    });
  }

  if (dbClearBtn) {
    dbClearBtn.addEventListener('click', async () => {
      const resp = prompt("CUIDADO: Isso vai apagar TODO o histórico do banco de dados.\nDigite 'APAGAR TUDO' para confirmar:");
      if (resp === 'APAGAR TUDO') {
        const { error } = await window.appSupabase.from('inadimplencia_history').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (!error) {
           alert("Histórico limpo!");
           await fetchDatabaseHistory();
        } else {
           alert("Erro: " + error.message);
        }
      }
    });
  }
}

// NOVA FUNÇÃO: BUSCAR DO BANCO
async function fetchDatabaseHistory() {
  if (!window.appSupabase) return;
  
  const baseUpdated = $('baseUpdated');
  if (baseUpdated) baseUpdated.textContent = 'Carregando dados da nuvem...';
  
  let allData = [];
  let lastCreatedAt = null;
  const cacheKey = 'inadimplencia_cache_v2';

  if (window.idbKeyval) {
    try {
      const cached = await idbKeyval.get(cacheKey);
      if (cached && cached.data) {
        allData = cached.data;
        lastCreatedAt = cached.lastCreatedAt;
      }
    } catch (e) {
      console.warn("Erro ao ler cache", e);
    }
  }

  let page = 0;
  const pageSize = 1000;
  let hasMore = true;
  let fetchedNew = false;

  while (hasMore) {
    let query = window.appSupabase
      .from('inadimplencia_history')
      .select('*')
      .order('created_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
      
    if (lastCreatedAt) {
      query = query.gt('created_at', lastCreatedAt);
    }

    const { data, error } = await query;
      
    if (error) {
      console.error('Erro ao buscar do Supabase', error);
      if (allData.length === 0) {
        alert('Não foi possível carregar os dados. Você criou a tabela no Supabase?');
        return;
      }
      break; // Usa o cache se falhar
    }

    if (data && data.length > 0) {
      allData = allData.concat(data);
      fetchedNew = true;
      page++;
      if (data.length < pageSize) hasMore = false;
    } else {
      hasMore = false;
    }
  }

  if (fetchedNew && window.idbKeyval && allData.length > 0) {
    try {
      const newLastCreatedAt = allData.reduce((max, r) => (r.created_at > max ? r.created_at : max), allData[0].created_at);
      await idbKeyval.set(cacheKey, { data: allData, lastCreatedAt: newLastCreatedAt });
    } catch (e) {
      console.warn("Erro ao salvar cache", e);
    }
  }
  
  const data = allData;

  if (!data || data.length === 0) {
    state.history = [];
    state.allOpenRows = [];
    state.overdueRows = [];
    if (baseUpdated) baseUpdated.textContent = 'Banco de dados vazio. Importe o primeiro arquivo!';
    renderAll();
    return;
  }
  
  // Agrupar os dados que vieram do banco pelo campo "data_base"
  const byDate = new Map();
  data.forEach(row => {
     if (!byDate.has(row.data_base)) {
        byDate.set(row.data_base, []);
     }
     byDate.get(row.data_base).push(row);
  });
  
  // --- CARTEIRA HISTORY ---
  let allCarteira = [];
  let lastCarteiraCreated = null;
  const cacheKeyCarteira = 'carteira_cache_v1';
  if (window.idbKeyval) {
    try {
      const cachedC = await idbKeyval.get(cacheKeyCarteira);
      if (cachedC && cachedC.data) {
        allCarteira = cachedC.data;
        lastCarteiraCreated = cachedC.lastCreatedAt;
      }
    } catch (e) { }
  }

  let pageC = 0;
  let hasMoreC = true;
  let fetchedNewC = false;
  while (hasMoreC) {
    let qC = window.appSupabase.from('carteira_history').select('*').order('created_at', { ascending: true }).range(pageC * pageSize, (pageC + 1) * pageSize - 1);
    if (lastCarteiraCreated) qC = qC.gt('created_at', lastCarteiraCreated);
    const { data: dataC, error: errC } = await qC;
    if (errC) {
      console.warn('Tabela carteira_history pode nao existir ainda ou erro:', errC);
      break;
    }
    if (dataC && dataC.length > 0) {
      allCarteira = allCarteira.concat(dataC);
      fetchedNewC = true;
      pageC++;
      if (dataC.length < pageSize) hasMoreC = false;
    } else {
      hasMoreC = false;
    }
  }

  if (fetchedNewC && window.idbKeyval && allCarteira.length > 0) {
    try {
      const newMax = allCarteira.reduce((m, r) => (r.created_at > m ? r.created_at : m), allCarteira[0].created_at);
      await idbKeyval.set(cacheKeyCarteira, { data: allCarteira, lastCreatedAt: newMax });
    } catch (e) { }
  }

  // Agrupar carteira
  const byDateC = new Map();
  allCarteira.forEach(row => {
     if (!byDateC.has(row.data_base)) byDateC.set(row.data_base, []);
     byDateC.get(row.data_base).push(row);
  });

  const history = [];
  Array.from(byDate.entries()).sort((a,b) => a[0].localeCompare(b[0])).forEach(([date, rows]) => {
     const overdue = rows.map(r => enrichRow(r));
     const openRows = byDateC.get(date) || [];
     const allOpen = openRows.map(r => enrichRow(r));
     
     history.push({
       date: date,
       file: 'Nuvem (Banco de Dados)',
       allOpen: allOpen,
       overdue: overdue,
       totalOpen: allOpen.length > 0 ? sum(allOpen.map(r => r.valor)) : sum(overdue.map(r => r.valor)),
       totalOverdue: sum(overdue.map(r => r.valor)),
       titles: overdue.length,
       clients: new Set(overdue.map(r => r.cliente)).size
     });
  });
  
  state.history = history;
  const latest = history[history.length - 1];
  
  state.allOpenRows = latest.overdue; // Sem a aba "em aberto", usamos os inadimplentes
  state.overdueRows = latest.overdue;
  state.sourceFile = 'Supabase Cloud DB';
  state.updatedAt = latest.date;
  
  if (baseUpdated) baseUpdated.textContent = `Dados em nuvem sincronizados! Base mais recente: ${showDate(latest.date)}`;
  
  refreshFilters();
  refreshYearFilter();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
