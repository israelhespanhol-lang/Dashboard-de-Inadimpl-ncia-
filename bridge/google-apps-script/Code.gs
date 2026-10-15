/**
 * Google Apps Script (projeto vinculado à conta que vê a pasta no Drive).
 *
 * 1) Ative "Drive API" em Serviços do Apps Script (Advanced Drive Service v3).
 * 2) Configure Script Properties:
 *    DRIVE_ROOT_ID, EDGE_FUNCTION_URL, BRIDGE_WEBHOOK_SECRET (>=32 caracteres),
 *    BRIDGE_MODE=validate, BATCH_SIZE=10, START_DATE=2026-08-26, CONTROL_SHEET_ID (opcional).
 * 3) Rode runBridgeBatch manualmente. Só depois instale o gatilho.
 * 4) Nunca coloque chave service_role nem tokens no código.
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function bridgeConfig_() {
  const p = PropertiesService.getScriptProperties();
  const root = p.getProperty('DRIVE_ROOT_ID');
  const url = p.getProperty('EDGE_FUNCTION_URL');
  const secret = p.getProperty('BRIDGE_WEBHOOK_SECRET');
  const mode = p.getProperty('BRIDGE_MODE') === 'commit' ? 'commit' : 'validate';
  const batchSize = Math.max(1, Math.min(25, Number(p.getProperty('BATCH_SIZE') || '10')));
  const startDate = p.getProperty('START_DATE');
  const controlSheetId = p.getProperty('CONTROL_SHEET_ID');
  if (!/^20\d\d-\d\d-\d\d$/.test(startDate || '')) throw new Error('Defina START_DATE=2026-08-26 na carga inicial.');
  if (!root || !url || !url.startsWith('https://') || !secret || secret.length < 32) {
    throw new Error('Script Properties incompletas: DRIVE_ROOT_ID, EDGE_FUNCTION_URL e BRIDGE_WEBHOOK_SECRET.');
  }
  // Exige habilitação consciente para sair de "validate".
  if (mode === 'commit' && p.getProperty('ALLOW_PRODUCTION_WRITES') !== 'YES') {
    throw new Error('Modo commit bloqueado. Configure ALLOW_PRODUCTION_WRITES=YES após os testes.');
  }
  return {root, url, secret, mode, batchSize, startDate, controlSheetId};
}

function listSourceFiles_(rootId) {
  const queue = [{id:rootId,path:'HISTORICO DE INADIMPLENCIA'}];
  const visited = {};
  const files = [];
  while (queue.length) {
    const folder = queue.shift();
    if (visited[folder.id]) continue;
    visited[folder.id] = true;
    let pageToken;
    do {
      const response = Drive.Files.list({
        q: "'" + folder.id.replace(/'/g, "\\'") + "' in parents and trashed = false",
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
        pageSize: 1000,
        pageToken: pageToken,
      });
      (response.files || []).forEach(item => {
        const path = folder.path + '/' + item.name;
        if (item.mimeType === FOLDER_MIME) queue.push({id:item.id,path});
        else if (item.mimeType === XLSX_MIME && /\.xlsx$/i.test(item.name) && !item.name.startsWith('~$')) {
          files.push({id:item.id,name:item.name,modifiedTime:item.modifiedTime,path});
        }
      });
      pageToken = response.nextPageToken;
    } while (pageToken);
  }
  files.sort((a,b) => a.path.localeCompare(b.path, 'pt-BR'));
  return files;
}

function dateFromName_(name) {
  const m = name.match(/(?:^|\D)(\d{2})[.\/_-]?(\d{2})[.\/_-]?(20\d{2})(?:\D|$)/);
  if (!m) return null;
  const iso = m[3] + '-' + m[2] + '-' + m[1];
  const dt = new Date(iso + 'T12:00:00Z');
  return !isNaN(dt.valueOf()) && dt.toISOString().slice(0,10) === iso ? iso : null;
}


// Inventário em cache para não consultar 58 pastas a cada minuto.
// CacheService limita cada item a 100 KB; fragmentamos em blocos menores.
function cachedSourceFiles_(rootId) {
  const cache = CacheService.getScriptCache();
  const key = 'bridge_v4_' + rootId.slice(-12);
  try {
    const n = Number(cache.get(key + '_n'));
    if (Number.isInteger(n) && n > 0 && n < 20) {
      const keys = Array.from({length:n}, (_,i) => key + '_' + i);
      const parts = cache.getAll(keys);
      if (keys.every(k => typeof parts[k] === 'string')) {
        return JSON.parse(keys.map(k => parts[k]).join(''))
          .map(r => ({id:r[0],name:r[1],modifiedTime:r[2],path:r[3]}));
      }
    }
  } catch (error) { console.warn('Cache de inventário indisponível:', error.message); }
  const files = listSourceFiles_(rootId);
  try {
    const raw = JSON.stringify(files.map(f => [f.id,f.name,f.modifiedTime,f.path]));
    const size = 75000;
    const n = Math.ceil(raw.length / size);
    const chunks = {};
    for (let i = 0; i < n; i++) chunks[key + '_' + i] = raw.slice(i*size,(i+1)*size);
    cache.putAll(chunks, 21600);
    cache.put(key + '_n', String(n), 21600);
  } catch (error) { console.warn('Não foi possível armazenar inventário:',error.message); }
  return files;
}

function clearInventoryCache_() {
  const root = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_ID');
  if (!root) return;
  const cache = CacheService.getScriptCache(), key = 'bridge_v4_' + root.slice(-12);
  const n = Number(cache.get(key + '_n') || 0);
  cache.removeAll([key + '_n', ...Array.from({length:Math.min(20,n)},(_,i) => key + '_' + i)]);
}

function updateControl_(cfg, file, situation, summary, message) {
  if (!cfg.controlSheetId) return;
  try {
    const sheet = SpreadsheetApp.openById(cfg.controlSheetId).getSheetByName('Sincronização');
    if (!sheet) throw new Error('Aba Sincronização não localizada');
    const last = sheet.getLastRow();
    const ids = last > 1 ? sheet.getRange(2, 4, last - 1, 1).getValues() : [];
    let index = ids.findIndex(r => String(r[0]) === file.id);
    const fileMonth = String(file.path || '').split('/').slice(-2,-1)[0] || '';
    const updated = [
      file.date || '', file.name, fileMonth, file.id, file.modifiedTime || '',
      situation, new Date().toISOString(),
      summary?.carteiraCount ?? '', summary?.totalOpen ?? '',
      summary?.overdueCount ?? '', summary?.totalOverdue ?? '',
      String(message || '').slice(0,350)
    ];
    if (index >= 0) sheet.getRange(index + 2, 1, 1, updated.length).setValues([updated]);
    else sheet.appendRow(updated);
  } catch (error) {
    // O monitor não deve interromper o processamento do financeiro.
    console.warn('Falha ao atualizar monitor:', error.message);
  }
}

function runBridgeBatch() {
  return runBridgeBatchWithConfig_(bridgeConfig_());
}

function runBridgeBatchWithConfig_(cfg) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Outra execução em andamento; este ciclo foi ignorado.');
    return {status:'LOCKED'};
  }
  try {
    const props = PropertiesService.getScriptProperties();
    // Uma leitura de propriedades é mais econômica do que consultar cada arquivo isoladamente.
    const statuses = props.getProperties();
    const entries = cachedSourceFiles_(cfg.root).filter(file => {
      file.date = dateFromName_(file.name);
      return file.date && file.date >= cfg.startDate &&
      (!cfg.endDate || file.date <= cfg.endDate);
    }).sort((a,b) => a.date.localeCompare(b.date));

    let success = 0, failed = 0, untouched = 0, deferred = 0;
    const errors = [];
    const updates = [];
    const changes = {};
    const removals = [];

    for (const file of entries) {
      const key = 'done_' + file.id;
      const fingerprint = cfg.mode + ':' + file.modifiedTime;
      if (statuses[key] === fingerprint) { untouched++; continue; }

      // A mesma versão com falha espera 10 minutos, para evitar loops de erro.
      const errorKey = 'error_' + file.id;
      const lastError = statuses[errorKey];
      if (lastError) {
        const sep = lastError.lastIndexOf('|');
        const date = Number(lastError.slice(sep + 1));
        if (lastError.slice(0,sep) === fingerprint && Date.now() - date < 10*60*1000) {
          deferred++;
          continue;
        }
      }
      if (success + failed >= cfg.batchSize) break;

      try {
        const blob = DriveApp.getFileById(file.id).getBlob();
        const response = UrlFetchApp.fetch(cfg.url, {
          method:'post',
          contentType:'application/json',
          headers:{'x-bridge-secret':cfg.secret},
          payload:JSON.stringify({
            mode:cfg.mode, fileId:file.id, fileName:file.name,
            modifiedTime:file.modifiedTime, contentBase64:Utilities.base64Encode(blob.getBytes()),
          }),
          muteHttpExceptions:true,
        });
        let body;
        try { body = JSON.parse(response.getContentText()); }
        catch (_) { throw new Error('HTTP '+response.getResponseCode()+' retornou conteúdo não-JSON'); }
        if (response.getResponseCode() !== 200) {
          throw new Error('HTTP '+response.getResponseCode()+': '+(body.error||'erro')+
            (body.detail?' / '+body.detail:''));
        }
        if (cfg.mode === 'validate' && body.status !== 'VALIDATED_NO_WRITE')
          throw new Error('A API não confirmou validação sem gravação');
        if (cfg.mode === 'commit' && !['INSERTED','REPLACED','UNCHANGED'].includes(body.database?.status))
          throw new Error('A API não confirmou operação no banco');

        changes[key] = fingerprint;
        if (lastError) removals.push(errorKey);
        success++;
        const dbStatus = body.database?.status;
        updates.push({file,situation:cfg.mode==='validate'?'VALIDADO':
          dbStatus==='REPLACED'?'REPROCESSADO':
          dbStatus==='UNCHANGED'?'SEM ALTERAÇÃO':'IMPORTADO',
          summary:body,message:''});
      } catch (error) {
        failed++;
        changes[errorKey] = fingerprint+'|'+Date.now();
        errors.push(file.path+': '+error.message);
        updates.push({file,situation:'ERRO',summary:null,message:error.message});
      }
    }

    // Um único acesso à planilha para cada lote (em vez de abrir o monitor 12 vezes).
    updateControlBatch_(cfg, updates);
    if (Object.keys(changes).length) props.setProperties(changes);
    removals.forEach(key => props.deleteProperty(key));

    const complete = success===0 && failed===0 && deferred===0 && untouched===entries.length;
    const report = {mode:cfg.mode,discovered:entries.length,processed:success,
      errors:failed,alreadyProcessed:untouched,deferred,complete,
      firstErrors:errors.slice(0,5)};
    console.log(JSON.stringify(report));

    // Após completar a auditoria, volta ao acionador de 1 hora para detectar
    // novos arquivos sem gastar recursos a cada minuto.
    if (complete && cfg.mode === 'validate') {
      clearInventoryCache_();
      installHourlyBridgeTrigger();
      console.log('Auditoria concluída. Acionador alterado automaticamente para 1 hora.');
    }
    return report;
  } finally {
    lock.releaseLock();
  }
}

function updateControlBatch_(cfg, updates) {
  if (!cfg.controlSheetId || !updates.length) return;
  const sheet = SpreadsheetApp.openById(cfg.controlSheetId).getSheetByName('Sincronização');
  if (!sheet) throw new Error('Monitor: aba Sincronização não encontrada');
  const last = sheet.getLastRow();
  const ids = last>1 ? sheet.getRange(2,4,last-1,1).getValues().flat() : [];
  const positions = new Map(ids.map((id,i) => [String(id),i+2]));
  const existing = [];
  const additions = [];
  updates.forEach(({file,situation,summary,message}) => {
    const month = String(file.path||'').split('/').slice(-2,-1)[0] || '';
    const row = [file.date||'',file.name,month,file.id,file.modifiedTime||'',
      situation,new Date().toISOString(),summary?.carteiraCount??'',
      summary?.totalOpen??'',summary?.overdueCount??'',summary?.totalOverdue??'',
      String(message||'').slice(0,350)];
    const position=positions.get(file.id);
    if (position) existing.push({position,row});
    else {
      additions.push(row);
      positions.set(file.id,last+additions.length);
    }
  });
  existing.sort((a,b) => a.position - b.position);
  for (let i=0;i<existing.length;) {
    const start=existing[i].position, group=[existing[i].row];
    while (++i<existing.length && existing[i].position === start + group.length)
      group.push(existing[i].row);
    sheet.getRange(start,1,group.length,12).setValues(group);
  }
  if (additions.length) {
    // O monitor começa com 1.000 linhas; expandir antes de acrescentar o histórico inteiro.
    const needed = last + additions.length;
    const capacity = sheet.getMaxRows();
    if (needed > capacity) sheet.insertRowsAfter(capacity, needed - capacity);
    sheet.getRange(last+1,1,additions.length,12).setValues(additions);
  }
}

function installHourlyBridgeTrigger() {
  // Não altera/instala gatilhos para outras funções do projeto.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runBridgeBatch')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runBridgeBatch').timeBased().everyHours(1).create();
}

function uninstallBridgeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runBridgeBatch')
    .forEach(t => ScriptApp.deleteTrigger(t));
}


// ATIVAÇÃO RÁPIDA: somente validação, jamais gravação financeira.
function installRapidHistoryValidation() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('BRIDGE_MODE') !== 'validate') {
    throw new Error('Aceleração permitida somente em BRIDGE_MODE=validate.');
  }
  bridgeConfig_();
  p.setProperties({'START_DATE':'2022-01-01','BATCH_SIZE':'12'});
  clearInventoryCache_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction()==='runBridgeBatch')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runBridgeBatch').timeBased().everyMinutes(1).create();
  console.log('MODO RÁPIDO: validação desde 2022, 12 arquivos/ciclo, execução a cada minuto.');
}

// Caso queira interromper o modo rápido, sem perder o que já foi validado.
function pauseRapidHistoryValidation() {
  ScriptApp.getProjectTriggers()
    .filter(t=>t.getHandlerFunction()==='runBridgeBatch')
    .forEach(t=>ScriptApp.deleteTrigger(t));
  console.log('Acionador suspenso. Histórico validado mantido.');
}


// CARGA CONTROLADA: não interfere com a validação agendada.
// A fonte histórica anterior a 26/08/2026 não será alterada.
function recentImportConfig_(batchSize, endDate) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('BRIDGE_MODE') !== 'validate') {
    throw new Error('Mantenha BRIDGE_MODE=validate nos gatilhos automáticos.');
  }
  if (props.getProperty('ALLOW_PRODUCTION_WRITES') !== 'YES') {
    throw new Error('Ative ALLOW_PRODUCTION_WRITES=YES somente depois da autorização da carga.');
  }
  const cfg = bridgeConfig_();
  return {
    ...cfg,
    mode:'commit',
    startDate:'2026-08-26',
    endDate: endDate || '2026-10-14',
    batchSize
  };
}

// Importa apenas 26/08/2026; evita habilitar commit na execução automática.
function runRecentPilotImport() {
  const cfg = recentImportConfig_(1, '2026-08-26');
  const report = runBridgeBatchWithConfig_(cfg);
  console.log('PILOTO FINANCEIRO: '+JSON.stringify(report));
  return report;
}

// Depois de conferir o resultado do piloto no Supabase e no site,
// execute manualmente as próximas datas (até 14/10/2026), 3 por vez.
// Nunca cria acionador de gravação automática.
function runRecentImportBatch() {
  const cfg = recentImportConfig_(3, '2026-10-14');
  const report = runBridgeBatchWithConfig_(cfg);
  console.log('CARGA RECENTE: '+JSON.stringify(report));
  return report;
}
