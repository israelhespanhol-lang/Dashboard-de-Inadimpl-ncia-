
alter table public.payment_history alter column due_date drop not null;
alter table public.payment_history alter column days_delay drop not null;
alter table public.payment_history add column if not exists source_due_raw text not null default '';
alter table public.payment_history add column if not exists data_quality text not null default 'ok';
create or replace function public.append_payment_history_chunk(
 p_source_key text,p_sha256 text,p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=''
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
 issue_date,due_date,payment_date,amount,days_delay,source_status,prazo_pgto,
 source_due_raw,data_quality)
 select p_source_key,p_sha256,src.source_row,coalesce(src.source_sheet,''),
 coalesce(src.customer_code,''),src.customer_name,coalesce(src.seller,''),
 coalesce(src.sap,''),coalesce(src.invoice,''),src.issue_date,src.due_date,
 src.payment_date,src.amount,src.days_delay,src.source_status,src.prazo_pgto,
 coalesce(src.source_due_raw,''),coalesce(src.data_quality,'ok')
 from jsonb_to_recordset(p_rows) as src (
  source_row integer,source_sheet text,customer_code text,customer_name text,seller text,sap text,
  invoice text,issue_date date,due_date date,payment_date date,amount numeric(20,2),
  days_delay integer,source_status text,prazo_pgto integer,source_due_raw text,data_quality text
 )
 on conflict(source_key,sha256,source_row) do nothing;
 get diagnostics v_inserted=row_count;
 return jsonb_build_object('status','APPENDED','received',v_count,'new_rows',v_inserted);
end;
$$;
revoke all on function public.append_payment_history_chunk(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.append_payment_history_chunk(text,text,jsonb) to service_role;
