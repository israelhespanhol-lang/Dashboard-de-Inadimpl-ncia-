# Importação da planilha única de pagamentos (XLSX) — preparada, sem execução financeira

O usuário confirmou que a origem de pagamentos é **um único arquivo XLS/XLSX**.
O arquivo não foi anexado à conversa nem identificado na pasta do Drive consultada.
O código foi preparado, mas a **carga real NÃO foi executada**.

## Componentes no GitHub
- `bridge/sql/03_payment_history.sql`: cria `payment_history_sources`, `payment_history`, índices, RLS para usuários autenticados e RPC `ingest_payment_history` segura/transacional. Não altera `carteira_history` ou `inadimplencia_history`.
- `supabase/functions/drive-payments/index.ts`: aceita XLSX, exige o mesmo `BRIDGE_WEBHOOK_SECRET` já guardado no Supabase, identifica planilha e colunas, calcula SHA-256 do arquivo, valida datas e valores, e só grava após duas autorizações independentes.
- `bridge/google-apps-script/Code.gs`: funções manuais `validatePaymentSourceWorkbook`, `authorizePaymentSourceImport`, `importPaymentSourceWorkbook` e `revokePaymentSourceImport`; nenhum trigger de importação automática.
- `script.js` + `payments-dashboard.js`: a aba lê pagamentos da nuvem depois que o banco estiver carregado, usando login e RLS. Enquanto não houver importação, a aba local continua funcionando.

## Ativação — após obter o arquivo e confirmar backup
1. Inspecionar o XLSX original: colunas, aba com pagamentos reais, datas, valores (pagos vs faturados), linhas duplicadas, pagamentos parciais.
2. Configurar `PAYMENTS_SOURCE_FILE_ID` no Apps Script para o arquivo do Drive (deve ser XLSX; converter legado XLS antes de executar) e `PAYMENTS_EDGE_FUNCTION_URL=https://hylycnzcnkwlqjwpuycc.supabase.co/functions/v1/drive-payments`.
   O valor `BRIDGE_WEBHOOK_SECRET` já existente é reutilizado, nunca copiado para GitHub.
3. Aplicar a migration SQL `03_payment_history.sql` somente no Supabase correto, confirmar as políticas RLS.
4. Fazer deploy separado da Edge Function `drive-payments` com `verify_jwt=false` (autenticação pelo webhook privado).
5. Executar `validatePaymentSourceWorkbook` em modo validate. Conferir soma, quantidade, avisos; não gravar dados ainda.
6. Após backup e autorização para importar: cadastrar Edge Function Secret `PAYMENTS_WRITE_ENABLED=true` e executar `authorizePaymentSourceImport` no Apps Script.
7. Rodar manualmente `importPaymentSourceWorkbook` uma vez. Confirmar retorno `IMPORTED` e `database.status=INSERTED`/`REPLACED`/`UNCHANGED`.
8. Verificar `payment_history_sources`, `payment_history` e dashboard com uma conta autenticada; evitar contagem dupla de arquivos/dados.
9. Desativar `PAYMENTS_WRITE_ENABLED` e revogar `ALLOW_PAYMENTS_IMPORT` depois do teste.

## Segurança e integridade
- Arquivos não são enviados a partir do navegador com segredo do webhook.
- O processamento do servidor recalcula SHA-256; reenvio idêntico não duplica lançamentos.
- Reenvio com conteúdo alterado substitui somente aquela fonte, numa transação.
- Números de clientes e notas podem se repetir legitimamente; por isso a chave é (arquivo, linha original), não a nota.
- O valor liquidado é priorizado. Se o arquivo tiver só o valor da nota, a função **não autoriza commit** até definir o tratamento de pagamentos parciais.
- Caso mais de uma aba tenha características de pagamentos, a validação exige selecionar explicitamente a correta.
- XLS clássico precisa ser convertido a XLSX; até 12 MB e 25.000 linhas por arquivo na versão inicial.
- Valores reais nunca devem ser misturados com os dados demonstrativos. 
- Os pagamentos não são descontados novamente do saldo da carteira em aberto.

### Estado de permissões em 15/10/2026
O conector Supabase devolveu `You do not have permission to perform this action`; a migração e o deploy **NÃO foram executados**.
