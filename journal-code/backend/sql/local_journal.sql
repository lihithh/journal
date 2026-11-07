-- Dedicated personal Journal storage. Existing account-based Journal tables stay intact.
-- The app credential is provisioned separately; only its SHA-256 hash is stored here.
create schema if not exists journal_private;
revoke all on schema journal_private from public, anon, authenticated;

do $$ begin
  if not exists(select 1 from pg_roles where rolname='journal_local_gateway') then
    create role journal_local_gateway nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant journal_local_gateway to postgres;

create table journal_private.connections (
  workspace_id uuid primary key default gen_random_uuid(),
  name text not null default 'My Journal',
  token_hash bytea not null unique check (octet_length(token_hash)=32),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table journal_private.entries (
  entry_id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references journal_private.connections(workspace_id),
  client_request_id uuid not null,
  journal_date date not null,
  title text not null default '' check (char_length(title)<=160),
  journal_text text not null default '' check (char_length(journal_text)<=20000),
  language text not null default 'en-IN' check (char_length(language) between 1 and 35),
  mood text not null default '' check (char_length(mood)<=40),
  photos jsonb not null default '[]' check (jsonb_typeof(photos)='array' and jsonb_array_length(photos)<=3),
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id,client_request_id),
  unique (workspace_id,journal_date)
);
create index journal_local_entries_cursor on journal_private.entries(workspace_id,entry_id);
alter table journal_private.connections enable row level security;
alter table journal_private.connections force row level security;
alter table journal_private.entries enable row level security;
alter table journal_private.entries force row level security;
revoke all on journal_private.connections,journal_private.entries from public,anon,authenticated;
grant usage on schema journal_private to journal_local_gateway;
grant select on journal_private.connections to journal_local_gateway;
grant select,insert,update on journal_private.entries to journal_local_gateway;
create policy gateway_verify_connection on journal_private.connections for select to journal_local_gateway using (true);
create policy gateway_read_entries on journal_private.entries for select to journal_local_gateway
  using (workspace_id=nullif(current_setting('journal.workspace_id',true),'')::uuid);
create policy gateway_insert_entries on journal_private.entries for insert to journal_local_gateway
  with check (workspace_id=nullif(current_setting('journal.workspace_id',true),'')::uuid);
create policy gateway_update_entries on journal_private.entries for update to journal_local_gateway
  using (workspace_id=nullif(current_setting('journal.workspace_id',true),'')::uuid)
  with check (workspace_id=nullif(current_setting('journal.workspace_id',true),'')::uuid);

-- A narrowly scoped credential authenticates this Mac; no user password or Supabase admin key.
-- The definer has permissions only on these two private tables and cannot bypass RLS.
create function journal_private.local_api(p_secret text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s'
as $$
declare
  connection journal_private.connections%rowtype;
  saved journal_private.entries%rowtype;
  rows_json jsonb;
  next_id uuid;
  photo jsonb;
begin
  if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='28000',message='Invalid Journal connection';
  end if;
  select * into connection from journal_private.connections
    where token_hash=sha256(convert_to(p_secret,'UTF8')) and revoked_at is null;
  if not found then raise exception using errcode='28000',message='Invalid Journal connection'; end if;
  perform set_config('journal.workspace_id',connection.workspace_id::text,true);
  if p_action='session' then
    return jsonb_build_object('workspace',jsonb_build_object('id',connection.workspace_id,'name',connection.name));
  elsif p_action='list' then
    select coalesce(jsonb_agg(to_jsonb(page) order by page.entry_id),'[]') into rows_json from (
      select * from journal_private.entries where workspace_id=connection.workspace_id
      and (nullif(p_payload->>'after','') is null or entry_id>(p_payload->>'after')::uuid)
      order by entry_id limit 20
    ) page;
    if jsonb_array_length(rows_json)=20 then next_id=(rows_json->19->>'entry_id')::uuid; end if;
    return jsonb_build_object('entries',rows_json,'next',next_id);
  elsif p_action not in ('create','update') or p_action is null then
    raise exception using errcode='22023',message='Unknown Journal operation';
  end if;

  if jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(p_payload->'title') is distinct from 'string' or char_length(p_payload->>'title')>160
    or jsonb_typeof(p_payload->'text') is distinct from 'string' or char_length(p_payload->>'text')>20000
    or jsonb_typeof(p_payload->'language') is distinct from 'string' or char_length(p_payload->>'language') not between 1 and 35
    or jsonb_typeof(p_payload->'mood') is distinct from 'string' or char_length(p_payload->>'mood')>40
    or jsonb_typeof(p_payload->'photos') is distinct from 'array' then
    raise exception using errcode='22023',message='Invalid Journal content';
  end if;
  if jsonb_array_length(p_payload->'photos')>3 then
    raise exception using errcode='22023',message='Up to three photos are supported';
  end if;
  for photo in select value from jsonb_array_elements(p_payload->'photos') loop
    if jsonb_typeof(photo->'src') is distinct from 'string'
      or (photo->>'src') !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$'
      or octet_length(photo->>'src')>2796248
      or (photo - 'src' - 'caption') <> '{}'::jsonb
      or jsonb_typeof(photo->'caption') is distinct from 'string' or char_length(photo->>'caption')>160 then
      raise exception using errcode='22023',message='Invalid photo or caption';
    end if;
  end loop;

  if p_action='create' then
    if p_payload->>'requestId' is null or p_payload->>'date' is null
      or (p_payload->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception using errcode='22023',message='Date and request ID required';
    end if;
    if not isfinite((p_payload->>'date')::date) then
      raise exception using errcode='22023',message='A finite journal date is required';
    end if;
    begin
      insert into journal_private.entries(workspace_id,client_request_id,journal_date,title,journal_text,language,mood,photos)
      values(connection.workspace_id,(p_payload->>'requestId')::uuid,(p_payload->>'date')::date,
        p_payload->>'title',p_payload->>'text',p_payload->>'language',p_payload->>'mood',p_payload->'photos')
      on conflict(workspace_id,client_request_id) do nothing returning * into saved;
      if not found then
        select * into saved from journal_private.entries where workspace_id=connection.workspace_id
          and client_request_id=(p_payload->>'requestId')::uuid;
      end if;
    exception when unique_violation then
      raise exception using errcode='40001',message='This date already has a Journal page';
    end;
  else
    select * into saved from journal_private.entries where workspace_id=connection.workspace_id
      and entry_id=(p_payload->>'id')::uuid for update;
    if not found or saved.version is distinct from (p_payload->>'expectedVersion')::integer
      or saved.updated_at is distinct from (p_payload->>'expectedUpdatedAt')::timestamptz then
      raise exception using errcode='40001',message='This page changed elsewhere; your local copy is preserved';
    end if;
    if (saved.title,saved.journal_text,saved.language,saved.mood,saved.photos) is distinct from
       (p_payload->>'title',p_payload->>'text',p_payload->>'language',p_payload->>'mood',p_payload->'photos') then
      update journal_private.entries set title=p_payload->>'title',journal_text=p_payload->>'text',
        language=p_payload->>'language',mood=p_payload->>'mood',photos=p_payload->'photos',
        version=version+1,updated_at=clock_timestamp()
        where workspace_id=connection.workspace_id and entry_id=saved.entry_id returning * into saved;
    end if;
  end if;
  return jsonb_build_object('entry',to_jsonb(saved));
end $$;
grant create on schema journal_private to journal_local_gateway;
alter function journal_private.local_api(text,text,jsonb) owner to journal_local_gateway;
revoke create on schema journal_private from journal_local_gateway;
revoke all on function journal_private.local_api(text,text,jsonb) from public;

-- Invoker wrapper exposed through REST. Private tables never receive public grants.
create function public.journal_local_api(p_secret text,p_action text,p_payload jsonb default '{}')
returns jsonb language sql security invoker set search_path=''
as $$ select journal_private.local_api(p_secret,p_action,p_payload) $$;
revoke all on function public.journal_local_api(text,text,jsonb) from public;
grant usage on schema journal_private to anon,authenticated;
grant execute on function journal_private.local_api(text,text,jsonb) to anon,authenticated;
grant execute on function public.journal_local_api(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
