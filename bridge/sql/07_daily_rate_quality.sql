-- 07_daily_rate_quality.sql
-- Correção auditável: posições com a base "inadimplentes" acidentalmente igual
-- à carteira toda. NÃO modifica carteira_history nem inadimplencia_history.
-- A taxa é reconstruída com (títulos da carteira cujo dias > 0) / carteira.
-- Valores originais incorretos ficam preservados em raw_total_overdue/raw_overdue_count.

alter table public.inadimplencia_daily_rate_cache
  add column if not exists data_quality text not null default 'source',
  add column if not exists raw_total_overdue numeric(20,2),
  add column if not exists raw_overdue_count bigint,
  add column if not exists quality_reason text;

create or replace function public.correct_duplicate_daily_rate()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  v_count bigint;
  v_due_count bigint;
  v_due_amount numeric;
begin
  -- Indicador de importação incorreta: TODA a carteira copiada como inadimplência.
  -- Exige prova adicional de títulos efetivamente vencidos dentro da própria carteira.
  if new.open_count >= 100
     and new.open_count = new.overdue_count
     and new.total_open = new.total_overdue then
    select count(*),count(*) filter (where dias > 0),
           coalesce(sum(valor) filter (where dias > 0),0)
      into v_count,v_due_count,v_due_amount
    from public.carteira_history
    where data_base = new.data_base;

    if v_count = new.open_count
       and v_due_count > 0
       and v_due_count < v_count
       and v_due_amount > 0
       and v_due_amount < new.total_open then
      new.raw_total_overdue := new.total_overdue;
      new.raw_overdue_count := new.overdue_count;
      new.total_overdue := round(v_due_amount,2);
      new.overdue_count := v_due_count;
      new.data_quality := 'reconstructed_from_due_titles';
      new.quality_reason :=
        'A tabela inadimplente recebeu toda a carteira; taxa reconstruída '
        || 'somando somente títulos com dias de atraso positivos.';
      return new;
    end if;
  end if;

  -- Uma importação futura com os dados corrigidos deixa de exigir reconstrução.
  new.data_quality := 'source';
  new.raw_total_overdue := null;
  new.raw_overdue_count := null;
  new.quality_reason := null;
  return new;
end;
$function$;

drop trigger if exists daily_rate_quality_guard on public.inadimplencia_daily_rate_cache;
create trigger daily_rate_quality_guard
before insert or update on public.inadimplencia_daily_rate_cache
for each row execute function public.correct_duplicate_daily_rate();

-- Reprocessa SOMENTE os três registros inconsistentes já identificados,
-- sem afetar qualquer linha nas tabelas de títulos.
update public.inadimplencia_daily_rate_cache
set total_overdue = total_overdue
where data_base in (date '2024-07-09',date '2024-11-29',date '2025-07-01')
  and total_open = total_overdue
  and open_count = overdue_count;

-- Uma nova RPC evita mudar o formato já usado por consumidores da API antiga.
create or replace function public.get_daily_inadimplencia_rate_audited()
returns table (
  snapshot_date text,
  total_open numeric, total_overdue numeric, rate numeric,
  open_count bigint, overdue_count bigint,
  data_quality text, raw_total_overdue numeric
)
language sql stable security definer set search_path = ''
as $function$
  select c.data_base::text, c.total_open, c.total_overdue,
     round(c.total_overdue/nullif(c.total_open,0),8)::numeric,
     c.open_count,c.overdue_count,c.data_quality,c.raw_total_overdue
  from public.inadimplencia_daily_rate_cache c
  where (select auth.uid()) is not null
  order by c.data_base;
$function$;
revoke all on function public.get_daily_inadimplencia_rate_audited()
  from public,anon;
grant execute on function public.get_daily_inadimplencia_rate_audited()
  to authenticated,service_role;

-- Conferência das reconstruções e do pico real.
select data_base,total_open,total_overdue,open_count,overdue_count,
  round(100*total_overdue/nullif(total_open,0),2) as corrected_pct,
  data_quality,raw_total_overdue
from public.inadimplencia_daily_rate_cache
where data_quality <> 'source'
order by data_base;
