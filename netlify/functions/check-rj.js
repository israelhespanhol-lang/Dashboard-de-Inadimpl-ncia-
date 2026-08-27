const API_URL = 'https://api.cnpj-api.com/v1/cnpj/';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function findValue(source, names) {
  if (!source || typeof source !== 'object') return '';
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (names.includes(normalized) && value != null && typeof value !== 'object') return String(value).trim();
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const found = findValue(value, names);
      if (found) return found;
    }
  }
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método não permitido.' });

  const token = process.env.CNPJ_API_TOKEN;
  if (!token) return json(503, { error: 'Configure CNPJ_API_TOKEN nas variáveis do Netlify.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido.' }); }
  const cnpj = String(payload.cnpj || '').replace(/\D/g, '');
  if (!/^\d{14}$/.test(cnpj)) return json(400, { error: 'CNPJ inválido.' });

  try {
    const response = await fetch(`${API_URL}${cnpj}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json(response.status, { error: data.error || `Falha na API de CNPJ (${response.status}).` });

    const specialStatus = findValue(data, ['situacaoespecial', 'specialstatus', 'situacaoespecialdescricao']);
    const companyName = findValue(data, ['razaosocial', 'nomeempresarial', 'companyname', 'nome']);
    const specialDate = findValue(data, ['datasituacaoespecial', 'specialstatusdate']);
    const normalized = specialStatus.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const nameNormalized = companyName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    const isRJ = normalized.includes('RECUPERACAO JUDICIAL') || nameNormalized.includes('EM RECUPERACAO JUDICIAL');

    return json(200, {
      cnpj,
      companyName,
      specialStatus: specialStatus || 'Nenhuma situação especial informada',
      specialDate,
      isRJ,
      checkedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      source: 'CNPJ API / dados da Receita Federal',
    });
  } catch {
    return json(502, { error: 'Não foi possível consultar o provedor de CNPJ.' });
  }
};
