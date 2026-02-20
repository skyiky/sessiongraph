-- Fix: use gen_random_uuid for api_key default (gen_random_bytes requires pgcrypto in search_path)
alter table profiles alter column api_key set default replace(gen_random_uuid()::text, '-', '');

-- Recreate trigger function with extensions in search_path
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;
