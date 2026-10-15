-- DIAGNÓSTICO SOMENTE LEITURA para HTTP 409 "statement timeout".
-- NÃO altera tabelas, permissões, segredos ou dados.
-- Executar no Supabase > SQL Editor, projeto Dashboard de Inadimplência.
WITH tabelas(nome) AS (
 VALUES ('inadimplencia_history'), ('carteira_history'), ('inadimplencia_source_versions'), ('inadimplencia_source_audit')
),
indices AS (
  SELECT tablename, jsonb_agg(jsonb_build_object(
    'nome', indexname,
    'definicao', indexdef
  ) ORDER BY indexname) AS encontrados
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename IN (SELECT nome FROM tabelas)
  GROUP BY tablename
)
SELECT
  t.nome AS tabela,
  pg_size_pretty(pg_total_relation_size(('public.' || quote_ident(t.nome))::regclass)) AS tamanho_total,
  (SELECT c.reltuples::bigint
   FROM pg_class c WHERE c.oid = ('public.' || quote_ident(t.nome))::regclass) AS linhas_estimadas,
  coalesce(i.encontrados, '[]'::jsonb) AS indices,
  (SELECT count(*) FROM public.inadimplencia_source_versions
   WHERE data_base = DATE '2026-08-26') AS versoes_piloto,
  (SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator') AS configuracao_authenticator,
  (SELECT rolconfig FROM pg_roles WHERE rolname = 'service_role') AS configuracao_service_role
FROM tabelas t
LEFT JOIN indices i ON i.tablename = t.nome
ORDER BY t.nome;
