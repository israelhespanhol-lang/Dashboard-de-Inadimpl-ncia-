-- 09_payment_import_chunked.sql
-- Versioned, resumable and idempotent XLSX imports. No writes to receivables.
create table if not exists public.payment_history_imports (
 source_key text not null,
 sha256 text not null,
 file_name text not null,
 expected_count integer not null check (expected_count > 0 and expected_count <= 100000),
 expected_total numeric(20,2) not null,
 status text not null default 'importing' check(status in ('importing','completed')),
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 primary key(source_key,sha256),
 check (sha256 ~ '^[a-f0-9]{64}$')
);
create table if not exists public.payment_history_sources (
 source_key text primary key,
 sha256 text not null,
 file_name text not null,
 row_count integer not null,
 total_received numeric(20,2) not null,
 imported_at timestamptz not null default now(),
 foreign key(source_key,sha256) references public.payment_history_imports(source_key,sha256)
);
create table if not exists public.payment_history (
 id bigint generated always as identity primary key,
 source_key text not null,
 sha256 text not null,
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
 source_status text not null,
 prazo_pgto integer,
 created_at timestamptz not null default now(),
 unique(source_key,sha256,source_row),
 foreign key(source_key,sha256) references public.payment_history_imports(source_key,sha256),
 check(days_delay=payment_date-due_date),
 check(source_status in ('EM DIA','EM ATRASO'))
);
create index if not exists payment_history_active_date_idx on public.payment_history(payment_date desc,id);
create index if not exists payment_history_customer_date_idx on public.payment_history(customer_code,payment_date desc);
create index if not exists payment_history_source_idx on public.payment_history(source_key,sha256);
create index if not exists payment_history_invoice_idx on public.payment_history(invoice);

alter table public.payment_history_imports enable row level security;
alter table public.payment_history_sources enable row level security;
alter table public.payment_history enable row level security;
revoke all on public.payment_history_imports from anon,authenticated;
revoke all on public.payment_history_sources from anon,authenticated;
revoke all on public.payment_history from anon,authenticated;
grant select on public.payment_history_sources to authenticated;
grant select on public.payment_history to authenticated;
grant all on public.payment_history_imports,public.payment_history_sources,public.payment_history to service_role;
grant usage,select on sequence public.payment_history_id_seq to service_role;

drop policy if exists payment_history_sources_read on public.payment_history_sources;
create policy payment_history_sources_read on public.payment_history_sources
 for select to authenticated using ((select auth.uid()) is not null);
drop policy if exists payment_history_active_read on public.payment_history;
create policy payment_history_active_read on public.payment_history
 for select to authenticated using (
   (select auth.uid()) is not null and exists (
     select 1 from public.payment_history_sources p
      where p.source_key = payment_history.source_key
        and p.sha256 = payment_history.sha256
   )
 );

create or replace function public.begin_payment_history_import(
 p_source_key text,p_file_name text,p_sha256 text,p_expected_count integer,p_expected_total numeric
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_status text;
begin
 if nullif(btrim(p_source_key),'') is null or length(p_source_key)>200
    or nullif(btrim(p_file_name),'') is null or length(p_file_name)>500
    or p_sha256 !~ '^[a-f0-9]{64}$'
    or p_expected_count is null or p_expected_count<1 or p_expected_count>100000
    or p_expected_total is null
 then raise exception 'INVALID_PAYMENT_SOURCE_METADATA'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('payments:'||p_source_key||':'||p_sha256));
 select status into v_status from public.payment_history_imports
 where source_key=p_source_key and sha256=p_sha256;
 if v_status='completed' then
   return jsonb_build_object('status','UNCHANGED','source_key',p_source_key,'hash',p_sha256);
 end if;
 insert into public.payment_history_imports(source_key,sha256,file_name,expected_count,expected_total)
 values(p_source_key,p_sha256,p_file_name,p_expected_count,p_expected_total)
 on conflict(source_key,sha256) do update set
  file_name=excluded.file_name
 where public.payment_history_imports.expected_count=excluded.expected_count
   and public.payment_history_imports.expected_total=excluded.expected_total
   and public.payment_history_imports.status='importing';
 if not found then raise exception 'SOURCE_HASH_METADATA_CONFLICT'; end if;
 return jsonb_build_object('status','READY','source_key',p_source_key);
end;
$$;

create or replace function public.append_payment_history_chunk(
 p_source_key text,p_sha256 text,p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_status text;v_count integer;v_inserted integer;
begin
 if jsonb_typeof(p_rows)<>'array' then raise exception 'EXPECTED_JSON_ROWS'; end if;
 v_count:=jsonb_array_length(p_rows);
 if v_count<1 or v_count>1000 then raise exception 'CHUNK_TOO_LARGE_OR_EMPTY'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('payments:'||p_source_key||':'||p_sha256));
 select status into v_status from public.payment_history_imports
 where source_key=p_source_key and sha256=p_sha256;
 if v_status is distinct from 'importing' then raise exception 'IMPORT_NOT_READY'; end if;
 insert into public.payment_history(
 source_key,sha256,source_row,source_sheet,customer_code,customer_name,seller,sap,invoice,
 issue_date,due_date,payment_date,amount,days_delay,source_status,prazo_pgto)
 select p_source_key,p_sha256,src.source_row,coalesce(src.source_sheet,''),
 coalesce(src.customer_code,''),src.customer_name,coalesce(src.seller,''),
 coalesce(src.sap,''),coalesce(src.invoice,''),src.issue_date,src.due_date,
 src.payment_date,src.amount,src.days_delay,src.source_status,src.prazo_pgto
 from jsonb_to_recordset(p_rows) as src (
  source_row integer,source_sheet text,customer_code text,customer_name text,seller text,sap text,
  invoice text,issue_date date,due_date date,payment_date date,amount numeric(20,2),
  days_delay integer,source_status text,prazo_pgto integer
 )
 on conflict(source_key,sha256,source_row) do nothing;
 get diagnostics v_inserted=row_count;
 return jsonb_build_object('status','APPENDED','received',v_count,'new_rows',v_inserted);
end;
$$;

create or replace function public.finish_payment_history_import(
 p_source_key text,p_sha256 text
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_record record;v_count bigint;v_sum numeric(20,2);
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('payments:'||p_source_key||':'||p_sha256));
 select * into v_record from public.payment_history_imports
 where source_key=p_source_key and sha256=p_sha256 for update;
 if not found then raise exception 'IMPORT_NOT_FOUND'; end if;
 if v_record.status='completed' then
   return jsonb_build_object('status','UNCHANGED','rows',v_record.expected_count,'total',v_record.expected_total);
 end if;
 select count(*),coalesce(sum(amount),0)::numeric(20,2) into v_count,v_sum
 from public.payment_history where source_key=p_source_key and sha256=p_sha256;
 if v_count<>v_record.expected_count or v_sum<>v_record.expected_total then
  raise exception 'RECONCILIATION_FAILED: count %/% amount %/%',
    v_count,v_record.expected_count,v_sum,v_record.expected_total;
 end if;
 update public.payment_history_imports set status='completed',finished_at=now()
 where source_key=p_source_key and sha256=p_sha256;
 insert into public.payment_history_sources(source_key,sha256,file_name,row_count,total_received,imported_at)
 values(p_source_key,p_sha256,v_record.file_name,v_count,v_sum,now())
 on conflict(source_key) do update set sha256=excluded.sha256,file_name=excluded.file_name,
  row_count=excluded.row_count,total_received=excluded.total_received,imported_at=excluded.imported_at;
 return jsonb_build_object('status','IMPORTED','rows',v_count,'total',v_sum);
end;
$$;
revoke all on function public.begin_payment_history_import(text,text,text,integer,numeric) from public,anon,authenticated;
revoke all on function public.append_payment_history_chunk(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finish_payment_history_import(text,text) from public,anon,authenticated;
grant execute on function public.begin_payment_history_import(text,text,text,integer,numeric) to service_role;
grant execute on function public.append_payment_history_chunk(text,text,jsonb) to service_role;
grant execute on function public.finish_payment_history_import(text,text) to service_role;
