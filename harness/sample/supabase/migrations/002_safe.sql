create table invoices (id bigint primary key, user_id uuid not null);
alter table invoices enable row level security;
create policy "own invoices" on invoices using (auth.uid() = user_id);
