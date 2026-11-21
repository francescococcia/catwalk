create table orders (id bigint primary key, user_id uuid not null, total numeric);
create table profiles (id uuid primary key, name text);
