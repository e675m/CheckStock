CREATE TABLE IF NOT EXISTS warehouse (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    archived boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_active_name
    ON warehouse (lower(name)) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS product (
    sku text PRIMARY KEY,
    name text NOT NULL
);
CREATE TABLE IF NOT EXISTS balance (
    warehouse_id integer REFERENCES warehouse,
    sku text REFERENCES product,
    physical bigint NOT NULL DEFAULT 0,
    reserved bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (warehouse_id, sku),
    CHECK (physical >= reserved AND reserved >= 0)
);
CREATE TABLE IF NOT EXISTS operation (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('receipt', 'transfer', 'fbs', 'fbo')),
    sku text NOT NULL REFERENCES product,
    quantity integer NOT NULL CHECK (quantity > 0),
    warehouse_id integer NOT NULL REFERENCES warehouse,
    destination_id integer REFERENCES warehouse,
    status text NOT NULL CHECK (status IN ('reserved', 'transit', 'received', 'cancelled')),
    CHECK ((kind = 'transfer') = (destination_id IS NOT NULL)),
    CHECK (warehouse_id <> destination_id)
);
CREATE TABLE IF NOT EXISTS event (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES operation,
    action text NOT NULL,
    happened_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (operation_id, action)
);
