-- 04_monthly_evolution.sql
-- HISTÓRICO MENSAL PARA GRÁFICOS. NÃO ALTERA carteira_history ou inadimplencia_history.
-- Cada mês usa a ÚLTIMA data com carteira e inadimplência presentes.
-- Cache por cliente + vendedor: filtra sem transferir 1,6M de títulos ao navegador.

create table if not exists public.inadimplencia_monthly_evolution_cache (
  snapshot_month date not null,
  data_base date not null,
  customer_key text not null,
  cliente text not null,
  gestor text not null default '',
  total_open numeric(20,2) not null default 0,
  total_overdue numeric(20,2) not null default 0,
  open_count bigint not null default 0,
  overdue_count bigint not null default 0,
  refreshed_at timestamptz not null default now(),
  primary key (snapshot_month, customer_key, gestor)
);
create index if not exists inadimplencia_monthly_cache_customer_idx
  on public.inadimplencia_monthly_evolution_cache(customer_key, snapshot_month);
create index if not exists inadimplencia_monthly_cache_manager_idx
  on public.inadimplencia_monthly_evolution_cache(gestor, snapshot_month);

alter table public.inadimplencia_monthly_evolution_cache enable row level security;
-- Somente a função agregada abaixo pode ler o cache como definer.
revoke all on public.inadimplencia_monthly_evolution_cache from anon,authenticated;
grant select,insert,update,delete on public.inadimplencia_monthly_evolution_cache to service_role;

-- Recalcula UM mês a partir dos registros que já estão no banco.
-- Exclusão/reinserção afeta somente o CACHE, nunca os documentos financeiros originais.
create or replace function public.refresh_inadimplencia_monthly_evolution(p_month date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := pg_catalog.date_trunc('month', p_month)::date;
  v_date date;
  v_rows integer := 0;
begin
  if p_month is null then raise exception 'MONTH_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('evolution-'||v_month::text));

  -- Último fechamento disponível no mês e presente NAS DUAS bases.
  select max(i.data_base) into v_date
    from public.inadimplencia_history i
   where i.data_base >= v_month
     and i.data_base < (v_month + interval '1 month')::date
     and exists (
       select 1 from public.carteira_history c where c.data_base=i.data_base
     );

  delete from public.inadimplencia_monthly_evolution_cache
    where snapshot_month=v_month;
  if v_date is null then return 0; end if;

  insert into public.inadimplencia_monthly_evolution_cache
    (snapshot_month,data_base,customer_key,cliente,gestor,
     total_open,total_overdue,open_count,overdue_count,refreshed_at)
  select
    v_month,v_date,base.customer_key,
    max(base.cliente),base.gestor,
    round(sum(base.total_open),2),round(sum(base.total_overdue),2),
    sum(base.open_count),sum(base.overdue_count),now()
  from (
    select
      coalesce(nullif(btrim(c.codigo),''),'NOME:'||upper(btrim(c.cliente))) as customer_key,
      coalesce(nullif(btrim(c.cliente),''),'Não identificado') as cliente,
      coalesce(btrim(c.gestor),'') as gestor,
      sum(c.valor)::numeric as total_open,
      0::numeric as total_overdue,
      count(*)::bigint as open_count,
      0::bigint as overdue_count
    from public.carteira_history c
    where c.data_base=v_date
    group by 1,2,3
    union all
    select
      coalesce(nullif(btrim(i.codigo),''),'NOME:'||upper(btrim(i.cliente))) as customer_key,
      coalesce(nullif(btrim(i.cliente),''),'Não identificado') as cliente,
      coalesce(btrim(i.gestor),'') as gestor,
      0::numeric as total_open,
      sum(case when i.dias>0 then i.valor else 0 end)::numeric as total_overdue,
      0::bigint as open_count,
      count(*) filter(where i.dias>0)::bigint as overdue_count
    from public.inadimplencia_history i
    where i.data_base=v_date
    group by 1,2,3
  ) base
  group by base.customer_key,base.gestor;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke all on function public.refresh_inadimplencia_monthly_evolution(date) from public,anon,authenticated;
grant execute on function public.refresh_inadimplencia_monthly_evolution(date) to service_role;

-- Mantém cache atualizado quando a ponte insere ou substitui um snapshot.
create or replace function public.monthly_evolution_after_snapshot()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform public.refresh_inadimplencia_monthly_evolution(new.data_base);
  return new;
end;
$$;
drop trigger if exists monthly_evolution_source_version_trg
  on public.inadimplencia_source_versions;
create trigger monthly_evolution_source_version_trg
  after insert or update on public.inadimplencia_source_versions
  for each row execute function public.monthly_evolution_after_snapshot();

-- O navegador só recebe SOMAS mensais, nunca a base detalhada inteira.
create or replace function public.get_monthly_evolution(
  p_cliente text default null,
  p_gestor text default null,
  p_search text default null
) returns table (
  snapshot_date text, snapshot_month text,
  total_open numeric, total_overdue numeric,
  rate numeric, open_count bigint, overdue_count bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  return query
    select e.data_base::text, e.snapshot_month::text,
           coalesce(sum(e.total_open),0)::numeric,
           coalesce(sum(e.total_overdue),0)::numeric,
           case when sum(e.total_open)>0
             then round(sum(e.total_overdue)/sum(e.total_open),6) else 0::numeric end,
           coalesce(sum(e.open_count),0)::bigint,
           coalesce(sum(e.overdue_count),0)::bigint
    from public.inadimplencia_monthly_evolution_cache e
    where (nullif(p_cliente,'') is null or p_cliente='Todos' or e.cliente=p_cliente)
      and (nullif(p_gestor,'') is null or p_gestor='Todos' or e.gestor=p_gestor)
      and (nullif(p_search,'') is null
        or e.cliente ilike '%'||p_search||'%' or e.customer_key ilike '%'||p_search||'%')
    group by e.snapshot_month,e.data_base
    order by e.snapshot_month;
end;
$$;
revoke all on function public.get_monthly_evolution(text,text,text) from public,anon;
grant execute on function public.get_monthly_evolution(text,text,text) to authenticated,service_role;

-- Carga inicial 2022–2026, somente ~60 posições mensais (não soma dias).
-- Se o SQL Editor limitar tempo, executar esta parte separadamente.
do $$
declare
  rec record;
  v_months integer:=0;
begin
  for rec in
    select distinct pg_catalog.date_trunc('month',data_base)::date as mes
      from public.inadimplencia_history
     where data_base is not null
     order by 1
  loop
    perform public.refresh_inadimplencia_monthly_evolution(rec.mes);
    v_months:=v_months+1;
  end loop;
  raise notice 'Histórico mensal reconstruído: % meses',v_months;
end;
$$;

-- Conferência de leitura (SQL Editor):
select snapshot_month, max(data_base) as data_base,
  round(sum(total_open),2) as carteira,round(sum(total_overdue),2) as inadimplente,
  round(100*sum(total_overdue)/nullif(sum(total_open),0),2) as taxa_percentual
from public.inadimplencia_monthly_evolution_cache
group by snapshot_month order by snapshot_month desc limit 12;
