# Ponte Google Drive → Supabase

## Diagnóstico de 14/10/2026
- Pasta fonte: HISTÓRICO DE INADIMPLENCIA, 2022 a 2026, 58 pastas mensais.
- Supabase: inadimplencia_history = 88.395 registros/1.127 datas; carteira_history = 1.638.090 registros/1.126 datas. Última data: 25/08/2026.
- 34 planilhas posteriores no Drive: 4 (agosto), 21 (setembro), 9 (outubro).
- Datas com registro apenas em uma tabela: 17/01/2022, 29/03/2022, 29/04/2022. Não corrigir automaticamente.

## Arquitetura e arquivos
- bridge/google-apps-script/Code.gs: varre a pasta, envia cada XLSX por HTTPS em lotes pequenos e registra resultado no monitor do Google Sheets.
- bridge/google-apps-script/appsscript.json: habilita o serviço avançado Drive API v3.
- supabase/functions/drive-inadimplencia/index.ts: autentica o webhook, lê abas Excel e valida dados.
- bridge/sql/01_snapshot_import.sql: instala registro de versão e RPC transacional.
- supabase/config.toml: permite endpoint sem JWT Supabase porque este webhook valida um segredo próprio.
- script.js: patch de cache para substituir datas revisadas e contemplar datas sem títulos vencidos.

## Segurança
- O endpoint exige um cabeçalho x-bridge-secret idêntico ao segredo privado do Supabase.
- Modo padrão validate: responde contagens e valores sem gravar nada.
- Commit depende de BRIDGE_WRITE_ENABLED=true no servidor e ALLOW_PRODUCTION_WRITES=YES no Apps Script.
- Datas preexistentes sem versão atribuída à ponte são bloqueadas, inclusive todas as datas históricas já carregadas.
- Uma nova versão do mesmo arquivo atualiza ambas as tabelas na mesma transação e registra auditoria.
- Nunca colocar chaves ou dados financeiros no GitHub público.

## Status de implantação (14/10/2026)
- SQL de registro/versões aplicado ao Supabase, novas tabelas inicialmente vazias e RLS validado.
- Edge Function drive-inadimplencia publicada como versão 1, status ACTIVE.
- O webhook ainda não dispõe de segredo compartilhado configurado, Apps Script não foi instalado.
- Portanto a automação NÃO está ativa e não foi feito upload de dados reais por essa ponte.

## Ativação restante
1. SQL já instalado; verificar novamente privilégios antes de colocar a ponte em produção.
2. Publicar a Edge Function; definir BRIDGE_WEBHOOK_SECRET (mínimo 32 caracteres) nos segredos privados.
3. Criar projeto em script.google.com, colar Code.gs e habilitar serviço avançado Drive API v3.
4. Definir Script Properties:
   DRIVE_ROOT_ID = ID da subpasta HISTÓRICO DE INADIMPLENCIA;
   EDGE_FUNCTION_URL = URL da Edge Function;
   BRIDGE_WEBHOOK_SECRET = mesmo segredo do backend;
   BRIDGE_MODE = validate;
   START_DATE = 2026-08-26;
   BATCH_SIZE = 3 para piloto, depois 10;
   CONTROL_SHEET_ID = ID privado do arquivo 'Monitor da Ponte - Inadimplência' criado no Drive.
5. Rodar runBridgeBatch manualmente e comparar totais das planilhas com o retorno do endpoint.
6. Somente após validar habilitar, conscientemente, BRIDGE_WRITE_ENABLED=true no servidor,
   BRIDGE_MODE=commit e ALLOW_PRODUCTION_WRITES=YES no Apps Script.
7. Instalar installHourlyBridgeTrigger para sincronização horária.
8. Expandir START_DATE para auditar os anos anteriores, após tratar divergências e datas existentes.

## Testes necessários
- Uma planilha de cada ano, verificando nomes de abas e saldos.
- Reenvio do mesmo arquivo deve resultar UNCHANGED.
- Correção no mesmo arquivo e data deve resultar REPLACED, com auditoria.
- Falha ao inserir em uma tabela deve reverter toda a transação.
- Segredo incorreto deve dar HTTP 401; commit desabilitado, HTTP 403.
- Testar limites de CPU do Supabase Edge/ExcelJS com os XLSX reais antes da carga.

## Limitações atuais
- O Apps Script precisa ser instalado em uma conta com acesso à pasta e autorizado no Google.
- A função está publicada e aguarda configuração de BRIDGE_WEBHOOK_SECRET antes dos testes HTTP.
- O monitor no Google Drive possui 34 arquivos em situação PENDENTE; após a autorização, Code.gs atualizará VALIDADO, IMPORTADO, ERRO etc.
- O navegador atual ainda precisa evoluir para consultas agregadas: mais de 1,6 milhão de registros
  de carteira tornam arriscado carregar todo o histórico em memória.
- Uma planilha renomeada com nova data requer conciliação manual da data antiga.

## Modo rápido para validar todo o histórico (2022–2026)

O código `bridge/google-apps-script/Code.gs` foi atualizado para acelerar a carga de validação.
**O arquivo do GitHub não modifica automaticamente o projeto que já está aberto no Google Apps Script.**

1. No projeto Apps Script existente, substituir integralmente o conteúdo de `Código.gs` pela versão atual do GitHub e salvar. Não modificar Script Properties sensíveis.
2. Executar uma vez `installRapidHistoryValidation` no seletor de funções.
3. Ela só funciona com `BRIDGE_MODE=validate`; define `START_DATE=2022-01-01` e `BATCH_SIZE=12`, remove o acionador horário antigo e cria UM acionador a cada minuto.
4. A varredura das pastas é guardada em cache por até 6 horas, com divisão em partes. A lista pode ser reconstruída caso o cache expire.
5. Cada execução usa LockService para impedir processamento simultâneo, guarda marcadores de arquivo, e atualiza o Monitor no Google Sheets em lote; erros têm retentativa após 10 minutos.
6. Após validar todos os arquivos descobertos, a automação volta sozinha a uma execução por hora. Novos arquivos/alterações posteriores serão redescobertos.
7. Para suspender antecipadamente sem perder progresso: executar `pauseRapidHistoryValidation`.

**Estimativa de capacidade:** 12 arquivos/minuto = 720 arquivos/hora na hipótese de cada execução terminar em menos de um minuto. Na prática o processamento é limitado por Drive, Apps Script (quotas e limite de tempo) e Edge Functions. Para cerca de 1.100–1.200 arquivos, o piso matemático é ~95–100 ciclos (aprox. 1h35), podendo levar várias horas. Verificar em **Execuções** se houver falhas/limites de quota.

**Atenção:** `VALIDADO` quer dizer que o Excel foi aceito e resumido pelo parser, **não** que foi reconciliado com as linhas históricas já armazenadas no Supabase. A conciliação de diferenças com o banco é uma etapa adicional. O modo rápido não insere nem corrige valores financeiros.

## Importação supervisionada dos arquivos recentes (2026-08-26 a 2026-10-14)

34 arquivos recentes: 31 VALIDADOS; 3 ERROS (21, 22 e 25 de setembro de 2026, por nomes de aba escritos incorretamente). Histórico anterior a 2026-08-26 NÃO deve ser sobrescrito.

1. Confirmar backup/ponto de restauração no Supabase.
2. Configurar Edge Functions Secrets: BRIDGE_WRITE_ENABLED = true, sem expor outras chaves.
3. Substituir Código.gs no Apps Script pela última versão deste repositório.
4. Manter BRIDGE_MODE = validate e START_DATE = 2022-01-01 nas propriedades. Definir ALLOW_PRODUCTION_WRITES = YES conscientemente.
5. Executar manualmente runRecentPilotImport. Esta função importa SOMENTE 2026-08-26 em commit, usando a RPC transacional e sem mudar o acionador de validação.
6. Confirmar processed:1 errors:0 no log e status IMPORTADO ou SEM ALTERAÇÃO no monitor. Confirmar no banco 1.244 títulos da carteira (R$ 72.811.274,25) e 66 inadimplentes (R$ 13.286.506,56), conferindo resultado também no dashboard.
7. Após o piloto, executar manualmente runRecentImportBatch (3 arquivos por execução) até completar as datas válidas de 2026-08-26 até 2026-10-14. Os três arquivos com erro só poderão ser processados após publicação da correção do parser.
8. Verificar inadimplencia_source_versions e inadimplencia_source_audit, as duas tabelas de histórico e indicadores do site; não declarar sucesso sem esta verificação.
9. Depois da carga, desabilitar temporariamente escrita no servidor BRIDGE_WRITE_ENABLED=false e remover ALLOW_PRODUCTION_WRITES do Apps Script até fechar a conciliação.

IMPORTANTE: modo validate não importa; apenas a função commit supervisionada grava. Não mudar BRIDGE_MODE global para commit com o trigger horário ligado. A carga dos históricos de 2022-2026 tem bloqueios por data já existente.
