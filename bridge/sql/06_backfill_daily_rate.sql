-- 06_backfill_daily_rate.sql
-- Rodar somente DEPOIS do 05_daily_rate.sql. Pode executar um ano por vez.
-- Cada chamada processa as posições diárias daquele ano e NÃO altera o histórico financeiro.
-- No editor SQL do Supabase, executar o bloco de um ano, aguardar finalizar
-- e então passar para o próximo. Se o timeout ocorrer, não repita os anos já concluídos.
-- Para dar mais margem à transação do Editor:
set statement_timeout = '120s';

-- PASSO 1
select public.refresh_inadimplencia_daily_rate_year(2022) as dias_2022;

-- PASSO 2
select public.refresh_inadimplencia_daily_rate_year(2023) as dias_2023;

-- PASSO 3
select public.refresh_inadimplencia_daily_rate_year(2024) as dias_2024;

-- PASSO 4
select public.refresh_inadimplencia_daily_rate_year(2025) as dias_2025;

-- PASSO 5
select public.refresh_inadimplencia_daily_rate_year(2026) as dias_2026;

-- VERIFICAÇÃO FINAL
select extract(year from data_base)::integer as ano,count(*) as dias,
       min(data_base) as primeira_data,max(data_base) as ultima_data,
       round(min(100*total_overdue/nullif(total_open,0)),2) as menor_taxa_pct,
       round(max(100*total_overdue/nullif(total_open,0)),2) as maior_taxa_pct
from public.inadimplencia_daily_rate_cache
group by extract(year from data_base) order by ano;

-- Comparação com o total exibido pelo arquivo de 26/08/2026
select data_base, total_open,total_overdue,
       round(100*total_overdue/nullif(total_open,0),2) as taxa_pct
from public.inadimplencia_daily_rate_cache
where data_base=date '2026-08-26';

-- DETECÇÃO DE LACUNAS: não inferir taxa quando uma das tabelas não tem a data.
select
 (select count(distinct data_base) from public.carteira_history) as dias_com_carteira,
 (select count(distinct data_base) from public.inadimplencia_history) as dias_com_inadimplencia,
 (select count(*) from public.inadimplencia_daily_rate_cache) as dias_com_ambas;
