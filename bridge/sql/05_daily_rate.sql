-- 05_daily_rate.sql
-- Taxa histórica DIÁRIA de inadimplência. Preserva as tabelas originais.
-- Fórmula: soma dos títulos da aba inadimplentes / soma da carteira * 100.
-- Apenas datas presentes EM AMBAS as bases são incluídas; não somar saldos de dias distintos.

create table if not exists public.inadimplencia_daily_rate_cache (
  data_base date primary key,
  total_open numeric(20,2) not null,
  total_overdue numeric(20,2) not null,
  open_count bigint not null,
  overdue_count bigint not null,
  calculated_at timestamptz not null default now(),
  constraint daily_rate_open_positive check (total_open > 0)
);
create index if not exists daily_rate_calculated_idx
  on public.inadimplencia_daily_rate_cache(calculated_at);
alter table public.inadimplencia_daily_rate_cache enable row level security;
revoke all on public.inadimplencia_daily_rate_cache from anon,authenticated;
grant select,insert,update,delete on public.inadimplencia_daily_rate_cache to service_role;

-- Execução de um ano por chamada; varre cada tabela uma vez para reduzir tempo.
-- Um reprocessamento atualiza apenas os resumos do ano informado.
create or replace function public.refresh_inadimplencia_daily_rate_year(p_year integer)
returns integer
language plpgsql security definer set search_path=''
as $$
declare
 v_from date;
 v_to date;
 v_rows integer;
begin
 if p_year < 2000 or p_year > 2040 then raise exception 'INVALID_YEAR'; end if;
 v_from := pg_catalog.make_date(p_year,1,1);
 v_to := pg_catalog.make_date(p_year+1,1,1);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('rate-year-'||p_year::text));

 -- Usar a soma da aba "Total Inadimplentes", inclusive ajustes assinados e
 -- eventuais linhas com dias=0, para bater com o total oficial da fonte.
 insert into public.inadimplencia_daily_rate_cache
   (data_base,total_open,total_overdue,open_count,overdue_count,calculated_at)
 select c.data_base,round(c.total_open,2),round(i.total_overdue,2),
        c.open_count,i.overdue_count,now()
 from (
   select data_base,sum(valor)::numeric as total_open,count(*)::bigint as open_count
   from public.carteira_history
   where data_base >= v_from and data_base < v_to
   group by data_base
 ) c
 inner join (
   select data_base,sum(valor)::numeric as total_overdue,count(*)::bigint as overdue_count
   from public.inadimplencia_history
   where data_base >= v_from and data_base < v_to
   group by data_base
 ) i on i.data_base=c.data_base
 where c.total_open>0
 on conflict(data_base) do update set
  total_open=excluded.total_open,
  total_overdue=excluded.total_overdue,
  open_count=excluded.open_count,
  overdue_count=excluded.overdue_count,
  calculated_at=excluded.calculated_at;

 get diagnostics v_rows=row_count;
 return v_rows;
end;
$$;
revoke all on function public.refresh_inadimplencia_daily_rate_year(integer)
 from public,anon,authenticated;
grant execute on function public.refresh_inadimplencia_daily_rate_year(integer) to service_role;

-- Recalcula somente o dia recém-importado, dentro da mesma transação da ponte.
create or replace function public.refresh_inadimplencia_daily_rate_day(p_date date)
returns integer
language plpgsql security definer set search_path=''
as $$
declare v_count integer;
begin
 if p_date is null then raise exception 'DATE_REQUIRED'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('rate-day-'||p_date::text));
 insert into public.inadimplencia_daily_rate_cache
   (data_base,total_open,total_overdue,open_count,overdue_count,calculated_at)
 select c.data_base,round(c.total_open,2),round(i.total_overdue,2),
   c.open_count,i.overdue_count,now()
 from (
   select data_base,sum(valor)::numeric as total_open,count(*)::bigint as open_count
   from public.carteira_history where data_base=p_date group by data_base
 ) c join (
   select data_base,sum(valor)::numeric as total_overdue,count(*)::bigint as overdue_count
   from public.inadimplencia_history where data_base=p_date group by data_base
 ) i using (data_base)
 where c.total_open>0
 on conflict(data_base) do update set
  total_open=excluded.total_open,total_overdue=excluded.total_overdue,
  open_count=excluded.open_count,overdue_count=excluded.overdue_count,
  calculated_at=excluded.calculated_at;
 get diagnostics v_count=row_count;
 return v_count;
end;
$$;
revoke all on function public.refresh_inadimplencia_daily_rate_day(date)
 from public,anon,authenticated;
grant execute on function public.refresh_inadimplencia_daily_rate_day(date) to service_role;

create or replace function public.daily_rate_after_snapshot()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 perform public.refresh_inadimplencia_daily_rate_day(new.data_base);
 return new;
end;
$$;
drop trigger if exists daily_rate_source_version_trg on public.inadimplencia_source_versions;
create trigger daily_rate_source_version_trg
 after insert or update on public.inadimplencia_source_versions
 for each row execute function public.daily_rate_after_snapshot();

-- RPC autenticada retorna só ~1.130 pontos, não os 1,6 milhão de lançamentos.
-- A série é CONSOLIDADA DA EMPRESA; não aceita filtro cliente/gestor.
create or replace function public.get_daily_inadimplencia_rate()
returns table (
 snapshot_date text, total_open numeric, total_overdue numeric,
 rate numeric, open_count bigint, overdue_count bigint
)
language sql stable security definer set search_path=''
as $$
 select c.data_base::text, c.total_open, c.total_overdue,
        round(c.total_overdue/nullif(c.total_open,0),8)::numeric,
        c.open_count,c.overdue_count
 from public.inadimplencia_daily_rate_cache c
 where (select auth.uid()) is not null
 order by c.data_base;
$$;
revoke all on function public.get_daily_inadimplencia_rate()
 from public,anon;
grant execute on function public.get_daily_inadimplencia_rate()
 to authenticated,service_role;

-- Conferir o estado ANTES do backfill; 0 linhas é esperado inicialmente.
select count(*) as dias_calculados,
       min(data_base) as primeira_data,
       max(data_base) as ultima_data
from public.inadimplencia_daily_rate_cache;
