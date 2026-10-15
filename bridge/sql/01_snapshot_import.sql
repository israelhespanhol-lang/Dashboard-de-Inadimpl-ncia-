-- ETAPA 1: executar somente após revisão do schema existente em ambiente de teste.
-- Não modifica histórico existente ao instalar.
-- Requer as tabelas public.inadimplencia_history e public.carteira_history.
create table if not exists public.inadimplencia_source_versions (
  data_base date primary key,
  drive_file_id text not null,
  file_name text not null,
  source_sha256 text not null,
  source_modified_at timestamptz,
  overdue_count integer not null check (overdue_count >= 0),
  carteira_count integer not null check (carteira_count > 0),
  total_overdue numeric not null,
  total_carteira numeric not null,
  imported_at timestamptz not null default now()
);
alter table public.inadimplencia_source_versions enable row level security;
revoke all on public.inadimplencia_source_versions from anon, authenticated;
grant select,insert,update,delete on public.inadimplencia_source_versions to service_role;

create table if not exists public.inadimplencia_source_audit (
  id bigint generated always as identity primary key,
  data_base date not null,
  drive_file_id text not null,
  file_name text not null,
  previous_sha256 text,
  new_sha256 text not null,
  event text not null check (event in ('INSERTED', 'REPLACED')),
  occurred_at timestamptz not null default now()
);
alter table public.inadimplencia_source_audit enable row level security;
revoke all on public.inadimplencia_source_audit from anon, authenticated;
grant select,insert,update,delete on public.inadimplencia_source_audit to service_role;

-- Uma chamada = uma transação: dados das DUAS tabelas e registro de versão.
-- Invoker = service_role; revogação impede execução por usuários do site.
create or replace function public.ingest_inadimplencia_snapshot(
  p_data_base date,
  p_drive_file_id text,
  p_file_name text,
  p_source_sha256 text,
  p_source_modified_at timestamptz,
  p_overdue jsonb,
  p_carteira jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old public.inadimplencia_source_versions%rowtype;
  v_overdue_count integer;
  v_carteira_count integer;
  v_total_overdue numeric;
  v_total_carteira numeric;
  v_event text;
begin
  if p_data_base is null or p_data_base < date '2000-01-01'
      or p_drive_file_id is null or length(trim(p_drive_file_id)) = 0
      or p_file_name is null or length(trim(p_file_name)) = 0
      or p_source_sha256 is null or length(p_source_sha256) <> 64 or p_source_sha256 ~ '[^0-9a-f]'
      or jsonb_typeof(p_overdue) is distinct from 'array'
      or jsonb_typeof(p_carteira) is distinct from 'array' then
    raise exception 'INVALID_SNAPSHOT_INPUT';
  end if;

  v_overdue_count := jsonb_array_length(p_overdue);
  v_carteira_count := jsonb_array_length(p_carteira);
  if v_carteira_count = 0 then raise exception 'EMPTY_CARTEIRA'; end if;

  select coalesce(sum(x.valor),0) into v_total_overdue
    from jsonb_to_recordset(p_overdue) as x(valor numeric);
  select coalesce(sum(x.valor),0) into v_total_carteira
    from jsonb_to_recordset(p_carteira) as x(valor numeric);
  if v_total_overdue < 0 or v_total_carteira < 0
      or v_total_overdue > v_total_carteira + 0.01 then
    raise exception 'INCONSISTENT_TOTALS';
  end if;

  -- Impede importações simultâneas para a mesma data.
  perform pg_advisory_xact_lock(hashtext(p_data_base::text));
  select * into v_old
    from public.inadimplencia_source_versions
    where data_base = p_data_base for update;

  if found then
    if v_old.drive_file_id <> p_drive_file_id then
      raise exception 'DATE_BELONGS_TO_DIFFERENT_FILE: %', p_data_base;
    end if;
    if v_old.source_sha256 = p_source_sha256 then
      return jsonb_build_object('status','UNCHANGED','date',p_data_base);
    end if;
    v_event := 'REPLACED';
  else
    -- Não altera datas cadastradas manualmente antes da ponte.
    if exists (select 1 from public.inadimplencia_history where data_base = p_data_base)
      or exists (select 1 from public.carteira_history where data_base = p_data_base) then
      raise exception 'DATE_HAS_UNMANAGED_ROWS: %', p_data_base;
    end if;
    v_event := 'INSERTED';
  end if;

  -- Falha em qualquer inserção desfaz ambas as tabelas automaticamente.
  delete from public.inadimplencia_history where data_base = p_data_base;
  delete from public.carteira_history where data_base = p_data_base;

  insert into public.inadimplencia_history
    (data_base,codigo,cnpj,cliente,documento,nf,emissao,vencimento,valor,dias,observacoes,gestor)
  select p_data_base,x.codigo,x.cnpj,x.cliente,x.documento,x.nf,
         x.emissao,x.vencimento,x.valor,x.dias,x.observacoes,x.gestor
  from jsonb_to_recordset(p_overdue) as x(
    codigo text, cnpj text, cliente text, documento text, nf text,
    emissao date, vencimento date, valor numeric, dias integer,
    observacoes text, gestor text
  );

  insert into public.carteira_history
    (data_base,codigo,cnpj,cliente,documento,nf,emissao,vencimento,valor,dias,observacoes,gestor)
  select p_data_base,x.codigo,x.cnpj,x.cliente,x.documento,x.nf,
         x.emissao,x.vencimento,x.valor,x.dias,x.observacoes,x.gestor
  from jsonb_to_recordset(p_carteira) as x(
    codigo text, cnpj text, cliente text, documento text, nf text,
    emissao date, vencimento date, valor numeric, dias integer,
    observacoes text, gestor text
  );

  insert into public.inadimplencia_source_versions
    (data_base,drive_file_id,file_name,source_sha256,source_modified_at,
     overdue_count,carteira_count,total_overdue,total_carteira,imported_at)
  values
    (p_data_base,p_drive_file_id,p_file_name,p_source_sha256,p_source_modified_at,
     v_overdue_count,v_carteira_count,v_total_overdue,v_total_carteira,now())
  on conflict (data_base) do update set
    drive_file_id = excluded.drive_file_id,
    file_name = excluded.file_name,
    source_sha256 = excluded.source_sha256,
    source_modified_at = excluded.source_modified_at,
    overdue_count = excluded.overdue_count,
    carteira_count = excluded.carteira_count,
    total_overdue = excluded.total_overdue,
    total_carteira = excluded.total_carteira,
    imported_at = now();

  insert into public.inadimplencia_source_audit
    (data_base,drive_file_id,file_name,previous_sha256,new_sha256,event)
  values
    (p_data_base,p_drive_file_id,p_file_name,v_old.source_sha256,p_source_sha256,v_event);

  return jsonb_build_object(
    'status',v_event,'date',p_data_base,
    'overdue_count',v_overdue_count,'carteira_count',v_carteira_count,
    'total_overdue',v_total_overdue,'total_carteira',v_total_carteira
  );
end;
$$;

revoke all on function public.ingest_inadimplencia_snapshot(
 date,text,text,text,timestamptz,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_inadimplencia_snapshot(
 date,text,text,text,timestamptz,jsonb,jsonb
) to service_role;
