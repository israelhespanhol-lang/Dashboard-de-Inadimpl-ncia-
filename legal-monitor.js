(function(){
  const Core = window.LegalCore || {
    cleanCnpj: v => String(v||'').replace(/\D/g,'').slice(0,14),
    formatCnpj: v => { const c = String(v||'').replace(/\D/g,'').slice(0,14); return c.length===14?c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5'):(v||'Não informado'); },
    validCnpj: v => String(v||'').replace(/\D/g,'').length===14,
    normalizeText: v => String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,' ').trim().toUpperCase(),
    calculateScore: () => ({ score: 0, label: 'Baixo', reasons: [] }),
    classifyEvent: () => 'OUTRO_PROCESSO_RELEVANTE',
    dedupeKey: i => `${i.processNumber||''}|${i.tribunal||''}`
  };
  const STORE_KEY = 'compo_legal_monitor_v1';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const fmtCnpj = value => (Core.formatCnpj ? Core.formatCnpj(value) : (typeof showCnpj === 'function' ? showCnpj(value) : value));
  
  const initial = { companies:[], cases:[], alerts:[], history:[], runs:[], reviews:[], settings:{ frequency:'manual', tribunal:'tjsp' } };
  let data = load(), activeTab = 'dashboard';

  function load(){
    try {
      return { ...initial, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch {
      return structuredClone(initial);
    }
  }

  function save(){
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    render();
  }

  const uid = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const now = () => new Date().toISOString();

  function parseSafeDate(value){
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const str = String(value).trim();
    const br = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (br) return new Date(`${br[3]}-${br[2].padStart(2,'0')}-${br[1].padStart(2,'0')}T12:00:00`);
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(value){
    const d = parseSafeDate(value);
    if (!d) return '—';
    const hasTime = typeof value === 'string' && value.includes('T');
    return new Intl.DateTimeFormat('pt-BR', { dateStyle:'short', timeStyle: hasTime ? 'short' : undefined }).format(d);
  }

  function showFeedback(message, error=false){
    const el = $('legalFeedback');
    if (!el) return;
    el.hidden = false;
    el.className = `legal-feedback${error ? ' error' : ''}`;
    el.textContent = message;
    clearTimeout(showFeedback.timer);
    showFeedback.timer = setTimeout(() => { el.hidden = true; }, 7000);
  }

  function companyEvents(companyId){
    return data.cases.filter(item => item.companyId === companyId && !item.needsReview);
  }

  function companyRisk(companyId){
    return Core.calculateScore(companyEvents(companyId));
  }

  function companyAlerts(companyId){
    return data.alerts.filter(item => item.companyId === companyId);
  }

  function riskBadge(label){
    const cls = String(label || 'Baixo').replace(/\s+/g, '-');
    return `<span class="badge risk-${cls}">${esc(label)}</span>`;
  }

  function renderKpis(){
    const day = 864e5, nowMs = Date.now();
    const recent = days => data.cases.filter(c => {
      const d = parseSafeDate(c.discoveredAt || c.date);
      return d ? (nowMs - d.getTime() <= days * day) : false;
    }).length;

    const monitored = data.companies.filter(c => c.monitoramentoAtivo);
    const verified = monitored.filter(c => c.lastCheckStatus === 'VERIFIED');
    const unverified = monitored.filter(c => c.lastCheckStatus !== 'VERIFIED');
    const assessed = data.companies.filter(c => c.lastCheckStatus === 'VERIFIED' || companyEvents(c.id).length);
    const counts = {};
    assessed.map(c => companyRisk(c.id)).forEach(r => { counts[r.label] = (counts[r.label] || 0) + 1; });

    const cards = [
      ['Empresas monitoradas', monitored.length],
      ['Verificadas', verified.length],
      ['Não verificadas', unverified.length],
      ['Sem alertas identificados', verified.filter(c => !companyAlerts(c.id).length).length],
      ['Em atenção', (counts.Atenção || 0) + (counts.Moderado || 0)],
      ['Risco alto', (counts.Alto || 0) + (counts.Crítico || 0)],
      ['Alertas novos', data.alerts.filter(a => a.status === 'Novo').length],
      ['Processos • 7 dias', recent(7)],
      ['Recuperações judiciais', data.cases.filter(c => c.normalizedEvent?.startsWith('RECUPERACAO_')).length],
      ['Falências', data.cases.filter(c => c.normalizedEvent?.startsWith('FALENCIA_')).length]
    ];

    if ($('legalKpis')) {
      $('legalKpis').innerHTML = cards.map(([label, value]) => `<div class="legal-kpi"><small>${label}</small><strong>${value}</strong></div>`).join('');
    }

    const levels = ['Baixo', 'Atenção', 'Moderado', 'Alto', 'Crítico'];
    const max = Math.max(1, unverified.length, ...levels.map(l => counts[l] || 0));

    if ($('legalRiskBars')) {
      $('legalRiskBars').innerHTML =
        `<div class="legal-risk-row"><span>Não verificado</span><div class="legal-risk-track"><span class="risk-unverified" style="width:${(unverified.length / max) * 100}%"></span></div><b>${unverified.length}</b></div>` +
        levels.map(level => `<div class="legal-risk-row"><span>${level}</span><div class="legal-risk-track"><span class="risk-${level}" style="width:${((counts[level] || 0) / max) * 100}%"></span></div><b>${counts[level] || 0}</b></div>`).join('');
    }

    const latestAlerts = [...data.alerts].sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0, 5);
    if ($('legalLatestAlerts')) {
      $('legalLatestAlerts').innerHTML = latestAlerts.length
        ? latestAlerts.map(a => {
            const company = data.companies.find(c => c.id === a.companyId);
            return `<div class="legal-alert-card"><div><strong>${esc(company?.razaoSocial || 'Empresa monitorada')}</strong><small>${esc(a.event)} • ${esc(a.tribunal || 'Tribunal não informado')} • ${fmtDate(a.date)}</small></div><button class="secondary-btn" data-detail="${a.companyId}">Ver detalhes</button></div>`;
          }).join('')
        : '<div class="empty-state">Nenhum alerta identificado. Empresas não verificadas não são consideradas livres de processos.</div>';
    }
  }

  function filteredCompanies(){
    const rawSearch = $('legalSearch')?.value || '';
    const term = Core.normalizeText(rawSearch);
    const cleanSearch = Core.cleanCnpj(rawSearch);
    const risk = $('legalRiskFilter')?.value;
    const alert = $('legalAlertFilter')?.value;

    return data.companies.filter(c => {
      const has = companyAlerts(c.id).length > 0;
      const label = companyRisk(c.id).label;
      const matchCnpj = cleanSearch && Core.cleanCnpj(c.cnpj).includes(cleanSearch);
      const matchText = !term || [c.razaoSocial, c.nomeFantasia, c.apelido, ...(c.aliases || [])].some(v => Core.normalizeText(v).includes(term));
      const matchSearch = matchCnpj || matchText;

      return matchSearch && (!risk || label === risk) && (!alert || (alert === 'with' ? has : !has));
    });
  }

  function renderCompanies(){
    const rows = filteredCompanies();
    if (!$('legalCompaniesTable')) return;
    $('legalCompaniesTable').innerHTML = rows.length
      ? rows.map(c => {
          const risk = companyRisk(c.id);
          const alerts = companyAlerts(c.id).length;
          const assessed = c.lastCheckStatus === 'VERIFIED' || companyEvents(c.id).length > 0;
          return `<tr><td><strong>${esc(c.razaoSocial)}</strong><small class="check-date">${esc(c.nomeFantasia || c.apelido || '')}</small></td><td>${fmtCnpj(c.cnpj)}</td><td>${esc([c.cidade, c.estado].filter(Boolean).join(' / ') || '—')}</td><td>${assessed ? `<span class="score-chip">${risk.score}</span>` : '—'}</td><td>${assessed ? riskBadge(risk.label) : '<span class="badge unverified">Não verificado</span>'}</td><td>${alerts}</td><td><div class="legal-row-actions"><button type="button" data-detail="${c.id}">Detalhes</button><button type="button" data-edit="${c.id}">Editar</button><button type="button" class="danger" data-delete="${c.id}">Excluir</button></div></td></tr>`;
        }).join('')
      : '<tr><td colspan="7" class="empty-state">Nenhuma empresa encontrada para os filtros selecionados.</td></tr>';
  }

  function renderAlerts(){
    const rows = [...data.alerts].sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    if (!$('legalAlertsTable')) return;
    $('legalAlertsTable').innerHTML = rows.length
      ? rows.map(a => {
          const company = data.companies.find(c => c.id === a.companyId);
          const isNovo = a.status === 'Novo';
          return `<tr><td><strong>${esc(company?.razaoSocial || 'Empresa')}</strong></td><td>${esc(a.event)}</td><td>${esc(a.tribunal || '—')}</td><td>${fmtDate(a.date)}</td><td>${riskBadge(a.level)}</td><td><span class="badge ${isNovo ? 'warn' : 'ok'}">${esc(a.status)}</span></td><td><button type="button" class="secondary-btn" data-read-alert="${a.id}">${isNovo ? 'Marcar como lido' : 'Marcar como novo'}</button></td></tr>`;
        }).join('')
      : '<tr><td colspan="7" class="empty-state">Nenhum alerta registrado.</td></tr>';
  }

  function renderCases(){
    const rows = [...data.cases].sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
    if (!$('legalCasesTable')) return;
    $('legalCasesTable').innerHTML = rows.length
      ? rows.map(c => {
          const company = data.companies.find(x => x.id === c.companyId);
          return `<tr><td><strong>${esc(c.processNumber || 'Sem número')}</strong></td><td>${esc(company?.razaoSocial || 'Possível correspondência')}</td><td>${esc(c.tribunal || '—')}</td><td>${esc(c.caseClass || c.subject || c.event || '—')}</td><td>${fmtDate(c.date)}</td><td>${esc(c.source || 'DataJud')}</td></tr>`;
        }).join('')
      : '<tr><td colspan="6" class="empty-state">Nenhum processo encontrado.</td></tr>';
  }

  function renderHistory(){
    const rows = [...data.history].sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    if (!$('legalHistory')) return;
    $('legalHistory').innerHTML = rows.length
      ? rows.map(h => `<div class="legal-history-item"><strong>${esc(h.message)}</strong><small>${fmtDate(h.createdAt)}</small></div>`).join('')
      : '<div class="empty-state">O histórico aparecerá após cadastros, importações e monitoramentos.</div>';
  }

  function render(){
    renderKpis();
    renderCompanies();
    renderAlerts();
    renderCases();
    renderHistory();
    if ($('legalFrequency')) $('legalFrequency').value = data.settings.frequency || 'manual';
    if ($('legalTribunal')) $('legalTribunal').value = data.settings.tribunal || 'tjsp';
  }

  function openCompany(company){
    const form = $('legalCompanyForm');
    if (!form) return;
    form.reset();
    form.elements.monitoramentoAtivo.checked = true;
    $('legalDialogTitle').textContent = company ? 'Editar empresa' : 'Nova empresa';
    if (company) {
      Object.entries(company).forEach(([key, value]) => {
        if (form.elements[key]) {
          if (form.elements[key].type === 'checkbox') {
            form.elements[key].checked = Boolean(value);
          } else {
            form.elements[key].value = key === 'aliases' ? (value || []).join(', ') : (value ?? '');
          }
        }
      });
    }
    const dialog = $('legalCompanyDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function saveCompany(form){
    const values = Object.fromEntries(new FormData(form));
    const cnpj = Core.cleanCnpj(values.cnpj);
    if (!Core.validCnpj(cnpj)) {
      showFeedback('CNPJ inválido. Confira os 14 dígitos e os verificadores.', true);
      return false;
    }
    const duplicate = data.companies.find(c => c.cnpj === cnpj && c.id !== values.id);
    if (duplicate) {
      showFeedback('Este CNPJ já está cadastrado em outra empresa.', true);
      return false;
    }
    const existing = data.companies.find(c => c.id === values.id);
    const company = {
      ...(existing || {}),
      id: values.id || uid('company'),
      razaoSocial: String(values.razaoSocial || '').trim(),
      nomeFantasia: String(values.nomeFantasia || '').trim(),
      cnpj,
      cidade: String(values.cidade || '').trim(),
      estado: String(values.estado || '').trim().toUpperCase(),
      segmento: String(values.segmento || '').trim(),
      apelido: String(values.apelido || '').trim(),
      status: values.status || 'ATIVO',
      observacoes: String(values.observacoes || '').trim(),
      aliases: String(values.aliases || '').split(',').map(v => v.trim()).filter(Boolean),
      monitoramentoAtivo: form.elements.monitoramentoAtivo.checked,
      updatedAt: now(),
      createdAt: existing?.createdAt || now()
    };

    const index = data.companies.findIndex(c => c.id === company.id);
    if (index >= 0) {
      data.companies[index] = company;
    } else {
      data.companies.push(company);
    }
    data.history.push({
      id: uid('history'),
      companyId: company.id,
      message: `Empresa ${index >= 0 ? 'atualizada' : 'cadastrada'}: ${company.razaoSocial}`,
      createdAt: now()
    });
    save();
    showFeedback('Empresa salva e incluída no monitoramento com sucesso.');
    return true;
  }

  function showDetail(id){
    const company = data.companies.find(c => c.id === id);
    if (!company) return;
    const risk = companyRisk(id);
    const cases = companyEvents(id);
    const alerts = companyAlerts(id);
    const assessed = company.lastCheckStatus === 'VERIFIED' || cases.length > 0;

    let casesHtml = '';
    if (cases.length) {
      casesHtml = `<div class="legal-detail-section"><h4>Processos vinculados (${cases.length})</h4><div class="legal-mini-table-wrap"><table class="legal-mini-table"><thead><tr><th>Processo</th><th>Tribunal</th><th>Classe / Assunto</th><th>Data</th></tr></thead><tbody>${cases.map(c => `<tr><td><strong>${esc(c.processNumber||'Sem número')}</strong></td><td>${esc(c.tribunal||'—')}</td><td>${esc(c.caseClass||c.subject||c.event||'—')}</td><td>${fmtDate(c.date)}</td></tr>`).join('')}</tbody></table></div></div>`;
    }

    let alertsHtml = '';
    if (alerts.length) {
      alertsHtml = `<div class="legal-detail-section"><h4>Alertas registrados (${alerts.length})</h4><ul class="legal-detail-alerts">${alerts.map(a => `<li><strong>${esc(a.event)}</strong> • ${esc(a.tribunal||'—')} • <small>${fmtDate(a.date)}</small> (${riskBadge(a.level)})</li>`).join('')}</ul></div>`;
    }

    $('legalCompanyDetail').innerHTML = `
      <div class="legal-detail-head">
        <div>
          <span class="section-kicker">Empresa monitorada</span>
          <h2>${esc(company.razaoSocial)}</h2>
          <p>${fmtCnpj(company.cnpj)} • ${esc([company.cidade, company.estado].filter(Boolean).join(' / ') || 'Local não informado')}</p>
        </div>
        <div class="legal-score-big">
          <small>${assessed ? 'RISCO' : 'COBERTURA'}</small>
          <strong>${assessed ? `${risk.score}/100` : '—'}</strong>
          <span>${assessed ? esc(risk.label) : 'Não verificado'}</span>
        </div>
      </div>
      <div class="legal-detail-section">
        <h4>Composição do score</h4>
        ${assessed
          ? (risk.reasons.length
              ? risk.reasons.map(r => `<p class="score-reason"><strong>+${r.points}</strong> ${esc(r.label)}</p>`).join('')
              : '<p class="muted-text">Nenhum evento gravoso de risco identificado pela cobertura disponível.</p>')
          : '<p class="muted-text">O score não foi calculado porque ainda não houve verificação por CNPJ.</p>'}
      </div>
      <div class="legal-detail-section">
        <h4>Resumo da situação</h4>
        <p>${cases.length} processo(s) confirmado(s) • ${alerts.length} alerta(s) • Última verificação: ${fmtDate(company.lastCheckedAt)}</p>
        ${company.lastCheckMessage ? `<p class="legal-disclaimer">${esc(company.lastCheckMessage)}</p>` : ''}
      </div>
      ${casesHtml}
      ${alertsHtml}
      <p class="legal-disclaimer">Ausência de alertas não comprova ausência de processos. Este indicador é um instrumento de apoio à análise de crédito.</p>
    `;
    $('legalDetailDialog').showModal();
  }

  function deleteCompany(id){
    const company = data.companies.find(c => c.id === id);
    if (!company || !confirm(`Deseja realmente excluir ${company.razaoSocial} do monitoramento?`)) return;
    data.companies = data.companies.filter(c => c.id !== id);
    data.cases = data.cases.filter(c => c.companyId !== id);
    data.alerts = data.alerts.filter(c => c.companyId !== id);
    data.history.push({ id: uid('history'), message: `Empresa removida do monitoramento: ${company.razaoSocial}`, createdAt: now() });
    save();
    showFeedback('Empresa e registros vinculados foram excluídos com sucesso.');
  }

  function clearLegalBase(){
    const total = data.companies.length;
    if (!total) {
      showFeedback('A base de monitoramento já está vazia.');
      return;
    }
    if (!confirm(`Remover todas as ${total} empresas monitoradas, processos, alertas e histórico? Esta ação é irreversível.`)) return;
    const settings = { ...data.settings };
    data = { ...structuredClone(initial), settings };
    save();
    showFeedback(`${total} empresas removidas. Base limpa com sucesso.`);
  }

  function parseCompanySheet(file){
    return file.arrayBuffer().then(buffer => {
      const workbook = XLSX.read(buffer, { type:'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
      if (!rows.length) throw new Error('Planilha vazia ou sem registros legíveis.');
      const headers = Object.keys(rows[0]);
      const find = aliases => headers.find(h => aliases.includes(Core.normalizeText(h)));
      const map = {
        razaoSocial: find(['RAZAO SOCIAL', 'NOME DO PN', 'CLIENTE', 'NOME', 'RAZAO']),
        nomeFantasia: find(['NOME FANTASIA', 'FANTASIA']),
        cnpj: find(['CNPJ', 'CPF CNPJ', 'CPF/CNPJ', 'DOCUMENTO FISCAL', 'DOC']),
        cidade: find(['CIDADE', 'NOME DO MUNICIPIO', 'MUNICIPIO']),
        estado: find(['ESTADO', 'UF'])
      };
      if (!map.razaoSocial || !map.cnpj) {
        throw new Error('A planilha precisa conter as colunas "Razão Social" (ou Nome) e "CNPJ".');
      }
      return rows.map(row => ({
        razaoSocial: String(row[map.razaoSocial] || '').trim(),
        nomeFantasia: map.nomeFantasia ? String(row[map.nomeFantasia] || '').trim() : '',
        cnpj: Core.cleanCnpj(row[map.cnpj]),
        cidade: map.cidade ? String(row[map.cidade] || '').trim() : '',
        estado: map.estado ? String(row[map.estado] || '').trim().toUpperCase() : ''
      })).filter(r => r.razaoSocial);
    });
  }

  async function importCompanies(file){
    const rows = await parseCompanySheet(file);
    const report = { imported:0, duplicates:0, invalid:0, ignored:0 };
    for (const row of rows) {
      if (!Core.validCnpj(row.cnpj)) {
        report.invalid++;
        continue;
      }
      if (data.companies.some(c => c.cnpj === row.cnpj)) {
        report.duplicates++;
        continue;
      }
      data.companies.push({
        ...row,
        id: uid('company'),
        aliases: [],
        status: 'ATIVO',
        monitoramentoAtivo: true,
        createdAt: now(),
        updatedAt: now()
      });
      report.imported++;
    }
    report.ignored = rows.length - report.imported - report.duplicates - report.invalid;
    data.history.push({
      id: uid('history'),
      message: `Importação: ${report.imported} adicionadas, ${report.duplicates} duplicadas, ${report.invalid} CNPJs inválidos`,
      createdAt: now()
    });
    save();
    showFeedback(`Importação concluída: ${report.imported} adicionadas • ${report.duplicates} já cadastradas • ${report.invalid} CNPJs inválidos.`);
  }

  function addCases(company, items){
    let created = 0;
    for (const item of items) {
      const normalizedEvent = Core.classifyEvent([item.caseClass, item.subject, item.event].join(' '));
      const record = {
        ...item,
        id: item.id || uid('case'),
        companyId: company.id,
        normalizedEvent,
        source: item.source || 'DataJud',
        discoveredAt: now()
      };
      if (data.cases.some(existing => Core.dedupeKey(existing) === Core.dedupeKey(record))) continue;
      data.cases.push(record);
      const risk = Core.calculateScore([record]);
      const level = item.needsReview ? 'Informativo' : risk.score >= 80 ? 'Crítico' : risk.score >= 60 ? 'Alto' : risk.score >= 20 ? 'Atenção' : 'Informativo';
      data.alerts.push({
        id: uid('alert'),
        companyId: company.id,
        caseId: record.id,
        event: item.needsReview ? `Possível correspondência: ${item.event || item.caseClass || normalizedEvent}` : (item.event || item.caseClass || normalizedEvent),
        tribunal: item.tribunal,
        date: item.date || now(),
        level,
        status: 'Novo',
        needsReview: Boolean(item.needsReview),
        createdAt: now()
      });
      created++;
    }
    return created;
  }

  async function checkNow(){
    const companies = data.companies.filter(c => c.monitoramentoAtivo && !c.isMock);
    if (!companies.length) {
      showFeedback('Nenhuma empresa ativa para pesquisar. Cadastre ou ative o monitoramento das empresas.', true);
      return;
    }

    const run = { id: uid('run'), status: 'RUNNING', startedAt: now(), companiesChecked: 0, casesFound: 0, alertsCreated: 0, errors: [], inconclusive: 0 };
    data.runs.push(run);
    save();

    const button = $('legalCheckBtn');
    if (button) button.disabled = true;

    let isBackendMissing = false;

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      if (button) button.textContent = `Pesquisando ${run.companiesChecked + 1}/${companies.length}`;
      try {
        const response = await fetch('/.netlify/functions/legal-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company })
        }).catch(err => {
          throw new Error('Endpoint backend não encontrado. O site precisa ser publicado no Netlify ou executado com Netlify Dev.');
        });

        if (response.status === 404) {
          isBackendMissing = true;
          throw new Error('Função /.netlify/functions/legal-search não encontrada. Faça o deploy no Netlify para ativar as consultas.');
        }

        const payload = await response.json().catch(() => ({}));
        if (payload.coverage === 'INCONCLUSIVE') {
          company.lastCheckStatus = 'INCONCLUSIVE';
          company.lastCheckMessage = payload.error;
          company.lastCheckedAt = payload.checkedAt || now();
          run.inconclusive++;
        } else if (!response.ok) {
          throw new Error(payload.error || `Provider respondeu status ${response.status}`);
        } else {
          const created = addCases(company, payload.cases || []);
          run.casesFound += (payload.cases || []).length;
          run.alertsCreated += created;
          company.lastCheckedAt = payload.checkedAt || now();
          company.lastCheckStatus = payload.coverage === 'COMPANY_IDENTITY' ? 'VERIFIED' : 'INCONCLUSIVE';
          company.lastCheckMessage = payload.truncated ? 'Resultado extenso: as primeiras 500 ocorrências foram processadas.' : '';
          if (company.lastCheckStatus !== 'VERIFIED') run.inconclusive++;
        }
      } catch (error) {
        company.lastCheckStatus = 'ERROR';
        company.lastCheckMessage = error.message;
        run.errors.push({ companyId: company.id, message: error.message });
        if (isBackendMissing) {
          // Break early if backend doesn't exist on local static host
          for (let j = i + 1; j < companies.length; j++) {
            companies[j].lastCheckStatus = 'ERROR';
            companies[j].lastCheckMessage = error.message;
            run.errors.push({ companyId: companies[j].id, message: error.message });
            run.companiesChecked++;
          }
          break;
        }
      }
      run.companiesChecked++;
      save();
      // Add safe throttle between external API requests
      if (i < companies.length - 1 && !isBackendMissing) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }

    run.status = run.errors.length ? 'COMPLETED_WITH_ERRORS' : run.inconclusive ? 'INCONCLUSIVE' : 'COMPLETED';
    run.finishedAt = now();
    data.history.push({
      id: uid('history'),
      message: `Pesquisa nacional: ${run.companiesChecked} empresas, ${run.inconclusive} inconclusivas, ${run.casesFound} processos e ${run.alertsCreated} alertas novos`,
      createdAt: now()
    });
    save();

    if (button) {
      button.disabled = false;
      button.textContent = 'Pesquisar em todo o Brasil';
    }

    if (isBackendMissing) {
      showFeedback('As consultas jurídicas exigem o backend Netlify. Faça o deploy no Netlify ou use o botão "Carregar demonstração" para testar localmente.', true);
    } else {
      showFeedback(
        run.inconclusive
          ? `${run.inconclusive} empresas não puderam ser verificadas diretamente. Configure ESCAVADOR_API_TOKEN para pesquisa completa por CNPJ.`
          : run.errors.length
            ? `Pesquisa finalizada com ${run.errors.length} erro(s). Clique em "Detalhes" da empresa para ver o motivo.`
            : `Pesquisa nacional concluída: ${run.casesFound} processo(s) e ${run.alertsCreated} alerta(s) novo(s).`
      );
    }
  }

  function loadMocks(){
    if (data.companies.length && !confirm('Adicionar empresas de demonstração separadas da base atual?')) return;
    const stamp = Date.now();
    const companies = [
      { id: `mock_a_${stamp}`, razaoSocial: 'EMPRESA DEMONSTRAÇÃO ALFA LTDA', nomeFantasia: 'Alfa Demo', cnpj: '11222333000181', estado: 'SP', cidade: 'Campinas' },
      { id: `mock_b_${stamp}`, razaoSocial: 'EMPRESA DEMONSTRAÇÃO BETA LTDA', nomeFantasia: 'Beta Demo', cnpj: '11444777000161', estado: 'MG', cidade: 'Uberlândia' },
      { id: `mock_c_${stamp}`, razaoSocial: 'EMPRESA DEMONSTRAÇÃO GAMA LTDA', nomeFantasia: 'Gama Demo', cnpj: '19131243000197', estado: 'PR', cidade: 'Curitiba' }
    ].map(c => ({ ...c, aliases: [], status: 'DEMONSTRAÇÃO', monitoramentoAtivo: false, isMock: true, createdAt: now(), updatedAt: now() }));

    data.companies.push(...companies);
    addCases(companies[1], [{ processNumber: '0000000-00.2026.8.26.0000', tribunal: 'TJSP', caseClass: 'Pedido de recuperação judicial', event: 'Pedido de recuperação judicial', date: now(), source: 'MOCK' }]);
    addCases(companies[2], [
      { processNumber: '1111111-00.2026.8.16.0000', tribunal: 'TJPR', caseClass: 'Execução fiscal', event: 'Execução fiscal recente', date: now(), source: 'MOCK' },
      { processNumber: '2222222-00.2026.8.16.0000', tribunal: 'TJPR', caseClass: 'Execução', event: 'Execução judicial', date: now(), source: 'MOCK' }
    ]);

    data.history.push({ id: uid('history'), message: 'Dados de demonstração carregados (identificados como MOCK)', createdAt: now() });
    save();
    showFeedback('Demonstração carregada com sucesso. Os dados estão identificados como MOCK.');
  }

  function bind(){
    document.querySelectorAll('[data-legal-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.legalTab;
        document.querySelectorAll('[data-legal-tab]').forEach(x => x.classList.toggle('active', x === btn));
        document.querySelectorAll('[data-legal-pane]').forEach(x => x.classList.toggle('active', x.dataset.legalPane === activeTab));
      });
    });

    $('legalAddBtn')?.addEventListener('click', () => openCompany());
    $('legalDialogClose')?.addEventListener('click', () => $('legalCompanyDialog')?.close());
    $('legalCancelBtn')?.addEventListener('click', () => $('legalCompanyDialog')?.close());

    $('legalCompanyForm')?.addEventListener('submit', event => {
      event.preventDefault();
      if (saveCompany(event.currentTarget)) $('legalCompanyDialog')?.close();
    });

    $('legalDetailClose')?.addEventListener('click', () => $('legalDetailDialog')?.close());

    // Backdrop click dismiss for dialogs
    [$('legalCompanyDialog'), $('legalDetailDialog')].forEach(dialog => {
      if (dialog) {
        dialog.addEventListener('click', event => {
          if (event.target === dialog) dialog.close();
        });
      }
    });

    $('legalImportBtn')?.addEventListener('click', () => $('legalImportInput')?.click());
    $('legalClearBtn')?.addEventListener('click', clearLegalBase);
    $('legalImportInput')?.addEventListener('change', event => {
      const file = event.target.files[0];
      if (file) importCompanies(file).catch(error => showFeedback(error.message, true));
      event.target.value = '';
    });

    $('legalMockBtn')?.addEventListener('click', loadMocks);
    $('legalCheckBtn')?.addEventListener('click', checkNow);

    ['legalSearch', 'legalRiskFilter', 'legalAlertFilter'].forEach(id => {
      $(id)?.addEventListener(id === 'legalSearch' ? 'input' : 'change', renderCompanies);
    });

    $('legalFrequency')?.addEventListener('change', e => {
      data.settings.frequency = e.target.value;
      save();
      showFeedback('Periodicidade configurada. A automação em background requer fila no backend.');
    });

    $('legalTribunal')?.addEventListener('change', e => {
      data.settings.tribunal = e.target.value;
      save();
    });

    $('monitor-empresarial')?.addEventListener('click', event => {
      const detail = event.target.closest('[data-detail]');
      const edit = event.target.closest('[data-edit]');
      const remove = event.target.closest('[data-delete]');
      const read = event.target.closest('[data-read-alert]');

      if (detail) showDetail(detail.dataset.detail);
      if (edit) openCompany(data.companies.find(c => c.id === edit.dataset.edit));
      if (remove) deleteCompany(remove.dataset.delete);
      if (read) {
        const alert = data.alerts.find(a => a.id === read.dataset.readAlert);
        if (alert) {
          alert.status = alert.status === 'Novo' ? 'Lido' : 'Novo';
          save();
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    render();
  });
})();
