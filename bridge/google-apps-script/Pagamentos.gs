/**
 * Fonte oficial de pagamentos da Compo Expert (XLSX, 2017–2026).
 * Este arquivo é INDEPENDENTE do Code.gs original da ponte de inadimplência.
 * O segredo permanece exclusivamente em Propriedades do script: BRIDGE_WEBHOOK_SECRET.
 *
 * Execução manual:
 * 1) validateOfficialPayments  -> apenas valida o Excel, sem gravar.
 * 2) importOfficialPayments    -> grava 36.175 pagamentos após validação.
 * Reiniciar a segunda função após um timeout é seguro: os lotes são idempotentes.
 */
const PAYMENT_BRIDGE_CONFIG_ = Object.freeze({
  sourceId: '1nzFExZ-mz09ygNfYyJZYEEhzMiDtRT7F',
  endpoint: 'https://hylycnzcnkwlqjwpuycc.supabase.co/functions/v1/drive-payments',
  expectedHash: '5022011aade1192d8a20834993489b93b3a2e13b368ec1bc98def2c487e5c11c',
  expectedRows: 36175,
  expectedTotal: 1394205568.35
});

function paymentFileHash_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function sendOfficialPayments_(mode) {
  const config = PAYMENT_BRIDGE_CONFIG_;
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('BRIDGE_WEBHOOK_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error('BRIDGE_WEBHOOK_SECRET não encontrado nas Propriedades do script.');
  }
  const file = DriveApp.getFileById(config.sourceId);
  const name = file.getName();
  if (!/\.xlsx$/i.test(name)) throw new Error('A origem deve ser uma planilha XLSX.');
  const bytes = file.getBlob().getBytes();
  const hash = paymentFileHash_(bytes);
  if (hash !== config.expectedHash) {
    throw new Error('O arquivo mudou desde a conferência. Não importar antes de nova auditoria.');
  }
  if (mode === 'commit' && props.getProperty('OFFICIAL_PAYMENTS_VALIDATED') !== hash) {
    throw new Error('Execute validateOfficialPayments primeiro e confira os números.');
  }
  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-bridge-secret': secret },
    payload: JSON.stringify({
      mode: mode,
      fileId: config.sourceId,
      fileName: name,
      contentBase64: Utilities.base64Encode(bytes)
    }),
    muteHttpExceptions: true
  };
  let http;
  try {
    http = UrlFetchApp.fetch(config.endpoint, request);
  } catch (error) {
    throw new Error('Conexão interrompida. A gravação em lotes pode ser retomada executando importOfficialPayments novamente. ' + error);
  }
  const code = http.getResponseCode();
  const body = JSON.parse(http.getContentText());
  if (code !== 200) {
    console.error('Resposta de pagamentos: ' + JSON.stringify(body));
    throw new Error('HTTP ' + code + ': ' + JSON.stringify(body));
  }
  if (mode === 'validate') {
    if (body.status !== 'VALIDATED_NO_WRITE'
        || body.rowCount !== config.expectedRows
        || Math.round(body.totalReceived * 100) !== Math.round(config.expectedTotal * 100)) {
      throw new Error('Conferência falhou: total e quantidade divergentes.');
    }
    props.setProperty('OFFICIAL_PAYMENTS_VALIDATED', hash);
    console.log('VALIDAÇÃO CONCLUÍDA (SEM GRAVAÇÃO): ' + JSON.stringify(body));
  } else {
    if (body.status !== 'IMPORTED'
        || !['IMPORTED','UNCHANGED'].includes(body.database?.status)) {
      throw new Error('O servidor não confirmou a importação.');
    }
    console.log('IMPORTAÇÃO OFICIAL CONFIRMADA: ' + JSON.stringify(body));
    props.deleteProperty('OFFICIAL_PAYMENTS_VALIDATED');
  }
  return body;
}
function validateOfficialPayments() {
  return sendOfficialPayments_('validate');
}
function importOfficialPayments() {
  return sendOfficialPayments_('commit');
}
