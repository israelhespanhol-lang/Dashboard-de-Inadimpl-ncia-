/**
 * Google Apps Script (projeto vinculado à conta que vê a pasta no Drive).
 *
 * 1) Ative "Drive API" em Serviços do Apps Script (Advanced Drive Service v3).
 * 2) Configure Script Properties:
 *    DRIVE_ROOT_ID, EDGE_FUNCTION_URL, BRIDGE_WEBHOOK_SECRET (>=32 caracteres),
 *    BRIDGE_MODE=validate, BATCH_SIZE=10, START_DATE=2026-08-26.
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
  if (!/^20\d\d-\d\d-\d\d$/.test(startDate || '')) throw new Error('Defina START_DATE=2026-08-26 na carga inicial.');
  if (!root || !url || !url.startsWith('https://') || !secret || secret.length < 32) {
    throw new Error('Script Properties incompletas: DRIVE_ROOT_ID, EDGE_FUNCTION_URL e BRIDGE_WEBHOOK_SECRET.');
  }
  // Exige habilitação consciente para sair de "validate".
  if (mode === 'commit' && p.getProperty('ALLOW_PRODUCTION_WRITES') !== 'YES') {
    throw new Error('Modo commit bloqueado. Configure ALLOW_PRODUCTION_WRITES=YES após os testes.');
  }
  return {root, url, secret, mode, batchSize, startDate};
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

function runBridgeBatch() {
  const cfg = bridgeConfig_();
  const props = PropertiesService.getScriptProperties();
  const entries = listSourceFiles_(cfg.root).filter(file => {
    file.date = dateFromName_(file.name);
    return file.date && file.date >= cfg.startDate;
  }).sort((a,b) => a.date.localeCompare(b.date));
  let success = 0, failed = 0, untouched = 0;
  const errors = [];

  for (const file of entries) {
    const key = 'done_' + file.id;
    const fingerprint = cfg.mode + ':' + file.modifiedTime;
    if (props.getProperty(key) === fingerprint) { untouched++; continue; }

    // Arquivos com erro só são tentados novamente após 6h ou se forem alterados.
    const errorKey = 'error_' + file.id;
    const recentError = props.getProperty(errorKey);
    if (recentError) {
      const parts = recentError.split('|');
      if (parts[0] === fingerprint && Date.now() - Number(parts[1]) < 6*60*60*1000) continue;
    }
    if (success + failed >= cfg.batchSize) break;

    try {
      const blob = DriveApp.getFileById(file.id).getBlob();
      const payload = {
        mode:cfg.mode,
        fileId:file.id,
        fileName:file.name,
        modifiedTime:file.modifiedTime,
        contentBase64:Utilities.base64Encode(blob.getBytes()),
      };
      const response = UrlFetchApp.fetch(cfg.url, {
        method:'post',
        contentType:'application/json',
        headers:{'x-bridge-secret':cfg.secret},
        payload:JSON.stringify(payload),
        muteHttpExceptions:true,
      });
      let body;
      try { body = JSON.parse(response.getContentText()); }
      catch (_) { throw new Error('Resposta não-JSON: HTTP ' + response.getResponseCode()); }
      if (response.getResponseCode() !== 200) {
        throw new Error('HTTP ' + response.getResponseCode() + ': ' + (body.error || 'erro desconhecido') +
          (body.detail ? ' / ' + body.detail : ''));
      }
      if (cfg.mode === 'validate' && body.status !== 'VALIDATED_NO_WRITE') {
        throw new Error('Resposta inesperada em validate');
      }
      if (cfg.mode === 'commit' && !['INSERTED','REPLACED','UNCHANGED'].includes(body.database?.status)) {
        throw new Error('Banco não confirmou gravação');
      }
      props.setProperty(key, fingerprint);
      props.deleteProperty(errorKey);
      success++;
      console.log(JSON.stringify({
        status:body.status || body.database?.status, date:body.date,
        source:file.name, mode:cfg.mode,
        overdueCount:body.overdueCount, carteiraCount:body.carteiraCount,
        totalOpen:body.totalOpen, totalOverdue:body.totalOverdue,
      }));
    } catch (err) {
      failed++;
      props.setProperty(errorKey, fingerprint + '|' + Date.now());
      errors.push(file.path + ': ' + err.message);
    }
  }

  const report = {mode:cfg.mode, discovered:entries.length, processed:success,
    errors:failed, alreadyProcessed:untouched, firstErrors:errors.slice(0,5)};
  console.log(JSON.stringify(report));
  return report;
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
