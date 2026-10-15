-- 08_daily_rate_quality_persistence.sql
-- Preserva metadados da reconstrução quando o cache é reprocessado via UPSERT.
-- Não modifica a carteira nem o histórico original.

create or replace function public.correct_duplicate_daily_rate()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  v_count bigint;
  v_due_count bigint;
  v_due_amount numeric;
begin
  -- Um upsert usa os números corrigidos no EXCLUDED, mas deixa as demais colunas
  -- da linha anterior. Mantenha sua marca de qualidade, caso a posição não mudou.
  if tg_op = 'UPDATE' then
    if old.data_quality = 'reconstructed_from_due_titles'
       and new.total_open = old.total_open
       and new.total_overdue = old.total_overdue
       and new.open_count = old.open_count
       and new.overdue_count = old.overdue_count then
      new.data_quality := old.data_quality;
      new.raw_total_overdue := old.raw_total_overdue;
      new.raw_overdue_count := old.raw_overdue_count;
      new.quality_reason := old.quality_reason;
      return new;
    end if;
  end if;

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
        'Tabela inadimplente contém carteira integral; valor reconstruído '||
        'com os títulos com dias de atraso positivos. Revisão de origem recomendada.';
      return new;
    end if;
  end if;

  new.data_quality := 'source';
  new.raw_total_overdue := null;
  new.raw_overdue_count := null;
  new.quality_reason := null;
  return new;
end;
$function$;

-- Restaura marca de auditoria perdida durante o teste de reprocessamento.
-- A reconstrução correta é feita novamente pelo próprio trigger.
update public.inadimplencia_daily_rate_cache
set total_overdue = total_open,
    overdue_count = open_count
where data_base = date '2025-07-01'
  and data_quality = 'source'
  and exists (
    select 1 from public.inadimplencia_history i
    where i.data_base = date '2025-07-01'
  );

select data_base,data_quality,raw_total_overdue,
       round(100*total_overdue/nullif(total_open,0),2) as corrected_pct
from public.inadimplencia_daily_rate_cache
where data_base in (date '2024-07-09',date '2024-11-29',date '2025-07-01')
order by data_base;
