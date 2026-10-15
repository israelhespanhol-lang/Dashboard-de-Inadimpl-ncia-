-- 03_payment_history.sql
-- Histórico de pagamentos: fluxo isolado de inadimplência/carteira.
-- REVISAO antes de executar na produção (não executa sozinho).
create table if not exists public.payment_history_sources (
  source_key text primary key,
  file_name text not null,
  sha256 text not null,
  row_count integer not null default 0,
  total_received numeric(20,2) not null default 0,
  imported_at timestamptz not null default now(),
  constraint payment_history_sources_sha_chk check (sha256 ~ '^[a-f0-9]{64}$')
);

create table if not exists public.payment_history (
  id bigint generated always as identity primary key,
  source_key text not null references public.payment_history_sources(source_key) on delete cascade,
  source_row integer not null,
  source_sheet text not null default '',
  customer_code text not null default '',
  customer_name text not null,
  seller text not null default '',
  sap text not null default '',
  invoice text not null default '',
  issue_date date,
  due_date date not null,
  payment_date date not null,
  amount numeric(20,2) not null,
  days_delay integer not null,
  created_at timestamptz not null default now(),
  unique(source_key, source_row),
  constraint payment_history_days_match check (days_delay = payment_date - due_date)
);
create index if not exists payment_history_date_idx on public.payment_history(payment_date desc, id);
create index if not exists payment_history_customer_idx on public.payment_history(customer_code);
create index if not exists payment_history_invoice_idx on public.payment_history(invoice);

-- Leitura apenas aos usuários autenticados do dashboard.
-- Não existe política de INSERT/UPDATE/DELETE para anon/authenticated.
alter table public.payment_history enable row level security;
alter table public.payment_history_sources enable row level security;
drop policy if exists payments_read_authenticated on public.payment_history;
create policy payments_read_authenticated on public.payment_history
  for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists payments_sources_read_authenticated on public.payment_history_sources;
create policy payments_sources_read_authenticated on public.payment_history_sources
  for select to authenticated using ((select auth.uid()) is not null);
revoke all on public.payment_history from anon, authenticated;
revoke all on public.payment_history_sources from anon, authenticated;
grant select on public.payment_history to authenticated;
grant select on public.payment_history_sources to authenticated;
grant all on public.payment_history to service_role;
grant all on public.payment_history_sources to service_role;
grant usage, select on sequence public.payment_history_id_seq to service_role;

-- Substituição atômica da fonte. Reimportar arquivo com hash idêntico é idempotente.
-- Há proteção adicional (Edge Function + segredo) para permitir gravação manual.
create or replace function public.ingest_payment_history(
  p_source_key text,
  p_file_name text,
  p_sha256 text,
  p_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $function$
declare
  v_previous text;
  v_expected bigint;
  v_count bigint;
  v_total numeric(20,2);
  v_status text;
begin
  if nullif(trim(p_source_key), '') is null or length(p_source_key)>250
    or nullif(trim(p_file_name), '') is null or length(p_file_name)>500
    or p_sha256 !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_rows) <> 'array'
  then
    raise exception 'INVALID_PAYMENT_IMPORT_INPUT';
  end if;

  v_expected := jsonb_array_length(p_rows);
  if v_expected < 1 or v_expected > 25000 then
    raise exception 'INVALID_PAYMENT_ROW_COUNT: %', v_expected;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_source_key, 0));
  select sha256 into v_previous from public.payment_history_sources where source_key=p_source_key for update;
  if v_previous=p_sha256 then
    return jsonb_build_object('status','UNCHANGED','source_key',p_source_key);
  end if;

  v_status := case when v_previous is null then 'INSERTED' else 'REPLACED' end;
  insert into public.payment_history_sources(source_key,file_name,sha256)
    values (p_source_key,p_file_name,p_sha256)
    on conflict (source_key) do update set file_name=excluded.file_name,sha256=excluded.sha256;

  delete from public.payment_history where source_key=p_source_key;
  insert into public.payment_history (
    source_key,source_row,source_sheet,customer_code,customer_name,seller,sap,invoice,
    issue_date,due_date,payment_date,amount,days_delay
  )
  select p_source_key, x.source_row,coalesce(x.source_sheet,''),coalesce(x.customer_code,''),
    x.customer_name,coalesce(x.seller,''),coalesce(x.sap,''),coalesce(x.invoice,''),
    x.issue_date,x.due_date,x.payment_date,x.amount,x.days_delay
  from jsonb_to_recordset(p_rows) as x(
    source_row integer,source_sheet text,customer_code text,customer_name text,
    seller text,sap text,invoice text,issue_date date,due_date date,
    payment_date date,amount numeric(20,2),days_delay integer
  );

  select count(*),coalesce(sum(amount),0) into v_count,v_total
    from public.payment_history where source_key=p_source_key;
  if v_count<>v_expected then
    raise exception 'PAYMENT_COUNT_MISMATCH: expected %, inserted %',v_expected,v_count;
  end if;
  update public.payment_history_sources set
    row_count=v_count,total_received=v_total,imported_at=now()
    where source_key=p_source_key;
  return jsonb_build_object('status',v_status,'source_key',p_source_key,
    'row_count',v_count,'total_received',v_total);
end;
$function$;
revoke all on function public.ingest_payment_history(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_payment_history(text,text,text,jsonb) to service_role;
