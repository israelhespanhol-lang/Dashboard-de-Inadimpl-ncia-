# Ponte Google Drive → Supabase

## Diagnóstico de 14/10/2026
- Pasta fonte: HISTÓRICO DE INADIMPLENCIA, 2022 a 2026, 58 pastas mensais.
- Supabase: inadimplencia_history = 88.395 registros/1.127 datas; carteira_history = 1.638.090 registros/1.126 datas. Última data: 25/08/2026.
- 34 planilhas posteriores no Drive: 4 (agosto), 21 (setembro), 9 (outubro).
- Datas com registro apenas em uma tabela: 17/01/2022, 29/03/2022, 29/04/2022. Não corrigir automaticamente.

## Arquitetura e arquivos
- bridge/google-apps-script/Code.gs: varre a pasta e envia cada XLSX por HTTPS em lotes pequenos.
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
   BATCH_SIZE = 3 para piloto, depois 10.
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
- A função necessita implantação e segredo antes dos testes HTTP.
- O navegador atual ainda precisa evoluir para consultas agregadas: mais de 1,6 milhão de registros
  de carteira tornam arriscado carregar todo o histórico em memória.
- Uma planilha renomeada com nova data requer conciliação manual da data antiga.
