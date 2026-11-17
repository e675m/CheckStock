INSERT INTO warehouse (name) VALUES ('Север'), ('Юг');
INSERT INTO product VALUES
    ('SKU-101', 'Органайзер'),
    ('SKU-102', 'Контейнер'),
    ('SKU-103', 'Корзина');

INSERT INTO operation (id, kind, sku, quantity, warehouse_id, status)
VALUES
    ('00000000-0000-4000-8000-000000000001', 'receipt', 'SKU-101', 10, 1, 'received'),
    ('00000000-0000-4000-8000-000000000002', 'receipt', 'SKU-101', 6, 2, 'received'),
    ('00000000-0000-4000-8000-000000000003', 'receipt', 'SKU-102', 5, 1, 'received'),
    ('00000000-0000-4000-8000-000000000004', 'receipt', 'SKU-103', 4, 2, 'received');

INSERT INTO balance (warehouse_id, sku, physical)
    SELECT warehouse_id, sku, quantity FROM operation;
INSERT INTO event (operation_id, action)
    SELECT id, 'created' FROM operation ORDER BY id;
