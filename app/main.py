import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row
from pydantic import BaseModel, Field, StringConstraints

ROOT = Path(__file__).resolve().parent


def connect():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)


def lock_writes(db):
    # The demo has one shop. Serialize its writes, including warehouse archival.
    db.execute("SELECT pg_advisory_xact_lock(71021)")


@asynccontextmanager
async def lifespan(app):
    with connect() as db:
        lock_writes(db)
        db.execute((ROOT / "schema.sql").read_text(encoding="utf-8"))
        if not db.execute("SELECT 1 FROM product LIMIT 1").fetchone():
            db.execute((ROOT / "demo.sql").read_text(encoding="utf-8"))
    yield


app = FastAPI(title="CheckStock", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


class WarehouseName(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


WarehouseId = Annotated[int, Field(gt=0, le=2147483647)]


class NewOperation(BaseModel):
    id: UUID
    kind: Literal["receipt", "transfer", "fbs", "fbo"]
    sku: str
    quantity: Annotated[int, Field(strict=True, gt=0, le=2147483647)]
    warehouse_id: WarehouseId
    destination_id: WarehouseId | None = None


def get_warehouse(db, warehouse_id, *, active=False):
    row = db.execute("SELECT * FROM warehouse WHERE id = %s", (warehouse_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Склад не найден.")
    if active and row["archived"]:
        raise HTTPException(409, "Склад в архиве. Выберите действующий склад.")
    return row


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/state")
def state():
    with connect() as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        return {
            "warehouses": db.execute("SELECT * FROM warehouse ORDER BY archived, id").fetchall(),
            "products": db.execute("SELECT * FROM product ORDER BY sku").fetchall(),
            "balances": db.execute("""
                SELECT w.id AS warehouse_id, p.sku,
                       coalesce(b.physical, 0) AS physical,
                       coalesce(b.reserved, 0) AS reserved
                FROM warehouse w CROSS JOIN product p
                LEFT JOIN balance b ON b.warehouse_id = w.id AND b.sku = p.sku
                ORDER BY p.sku, w.archived, w.id
            """).fetchall(),
            "operations": db.execute("""
                SELECT o.* FROM operation o JOIN event e
                ON e.operation_id = o.id AND e.action = 'created'
                WHERE o.status IN ('reserved', 'transit') ORDER BY e.id DESC
            """).fetchall(),
            "history": db.execute("""
                SELECT o.id, o.kind, o.sku, o.quantity, o.warehouse_id, o.destination_id,
                       e.action, e.happened_at
                FROM event e JOIN operation o ON o.id = e.operation_id ORDER BY e.id DESC
            """).fetchall(),
        }


@app.post("/api/warehouses", status_code=201)
def add_warehouse(data: WarehouseName):
    try:
        with connect() as db:
            lock_writes(db)
            return db.execute(
                "INSERT INTO warehouse (name) VALUES (%s) RETURNING *", (data.name,)
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "Действующий склад с таким названием уже есть.") from exc


@app.patch("/api/warehouses/{warehouse_id}")
def rename_warehouse(warehouse_id: WarehouseId, data: WarehouseName):
    try:
        with connect() as db:
            lock_writes(db)
            get_warehouse(db, warehouse_id, active=True)
            return db.execute(
                "UPDATE warehouse SET name = %s WHERE id = %s RETURNING *",
                (data.name, warehouse_id),
            ).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, "Действующий склад с таким названием уже есть.") from exc


@app.delete("/api/warehouses/{warehouse_id}")
def archive_warehouse(warehouse_id: WarehouseId):
    with connect() as db:
        lock_writes(db)
        get_warehouse(db, warehouse_id)
        return db.execute(
            "UPDATE warehouse SET archived = true WHERE id = %s RETURNING *", (warehouse_id,)
        ).fetchone()


def credit(db, warehouse_id, sku, quantity):
    db.execute("""
        INSERT INTO balance (warehouse_id, sku, physical) VALUES (%s, %s, %s)
        ON CONFLICT (warehouse_id, sku) DO UPDATE
        SET physical = balance.physical + excluded.physical
    """, (warehouse_id, sku, quantity))


def require_stock(db, warehouse, sku, quantity):
    row = db.execute("""
        SELECT physical - reserved AS available FROM balance
        WHERE warehouse_id = %s AND sku = %s
    """, (warehouse["id"], sku)).fetchone()
    available = row["available"] if row else 0
    if available >= quantity:
        return

    alternatives = db.execute("""
        SELECT w.name, b.physical - b.reserved AS available
        FROM balance b JOIN warehouse w ON w.id = b.warehouse_id
        WHERE b.sku = %s AND w.id <> %s AND NOT w.archived AND b.physical > b.reserved
        ORDER BY w.name
    """, (sku, warehouse["id"])).fetchall()
    message = f'На складе «{warehouse["name"]}» доступно {available} из {quantity} шт.'
    if alternatives:
        stock = ", ".join(f'{row["name"]} — {row["available"]} шт.' for row in alternatives)
        message += f" На других действующих складах: {stock}. Выберите склад или оформите перемещение."
    raise HTTPException(409, message)


@app.post("/api/operations", status_code=201)
def create_operation(data: NewOperation):
    with connect() as db:
        lock_writes(db)
        existing = db.execute("SELECT * FROM operation WHERE id = %s", (data.id,)).fetchone()
        if existing:
            if any(existing[key] != value for key, value in data.model_dump().items()):
                raise HTTPException(409, "Этот идентификатор уже использован для другой операции.")
            return existing

        warehouse = get_warehouse(db, data.warehouse_id)
        if warehouse["archived"] and data.kind != "transfer":
            raise HTTPException(409, "С архивного склада доступен только вывоз на действующий склад.")
        if data.kind == "transfer":
            if data.destination_id is None or data.destination_id == data.warehouse_id:
                raise HTTPException(422, "Выберите другой склад назначения.")
            get_warehouse(db, data.destination_id, active=True)
        elif data.destination_id is not None:
            raise HTTPException(422, "Склад назначения указывается для перемещения между ФФ.")
        if not db.execute("SELECT 1 FROM product WHERE sku = %s", (data.sku,)).fetchone():
            raise HTTPException(404, "Артикул не найден.")

        if data.kind == "receipt":
            credit(db, data.warehouse_id, data.sku, data.quantity)
            status = "received"
        else:
            require_stock(db, warehouse, data.sku, data.quantity)
            if data.kind == "fbs":
                db.execute("""
                    UPDATE balance SET reserved = reserved + %s WHERE warehouse_id = %s AND sku = %s
                """, (data.quantity, data.warehouse_id, data.sku))
                status = "reserved"
            else:
                db.execute("""
                    UPDATE balance SET physical = physical - %s WHERE warehouse_id = %s AND sku = %s
                """, (data.quantity, data.warehouse_id, data.sku))
                status = "transit"

        operation = db.execute("""
            INSERT INTO operation (id, kind, sku, quantity, warehouse_id, destination_id, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *
        """, (data.id, data.kind, data.sku, data.quantity, data.warehouse_id,
              data.destination_id, status)).fetchone()
        db.execute("INSERT INTO event (operation_id, action) VALUES (%s, 'created')", (data.id,))
        return operation


TRANSITIONS = {
    "send": ("reserved", "transit"),
    "cancel": ("reserved", "cancelled"),
    "receive": ("transit", "received"),
}


@app.post("/api/operations/{operation_id}/{action}")
def confirm(operation_id: UUID, action: Literal["send", "cancel", "receive"]):
    with connect() as db:
        lock_writes(db)
        operation = db.execute("SELECT * FROM operation WHERE id = %s", (operation_id,)).fetchone()
        if not operation:
            raise HTTPException(404, "Операция не найдена.")
        if db.execute("""
            SELECT 1 FROM event WHERE operation_id = %s AND action = %s
        """, (operation_id, action)).fetchone():
            return operation

        expected, status = TRANSITIONS[action]
        if operation["status"] != expected:
            raise HTTPException(409, "Действие недоступно в текущем статусе.")
        quantity = operation["quantity"]
        sku = operation["sku"]
        if action in ("send", "cancel"):
            shipped = quantity if action == "send" else 0
            db.execute("""
                UPDATE balance SET reserved = reserved - %s, physical = physical - %s
                WHERE warehouse_id = %s AND sku = %s
            """, (quantity, shipped, operation["warehouse_id"], sku))
        elif operation["kind"] == "transfer":
            credit(db, operation["destination_id"], sku, quantity)

        db.execute("INSERT INTO event (operation_id, action) VALUES (%s, %s)", (operation_id, action))
        return db.execute("""
            UPDATE operation SET status = %s WHERE id = %s RETURNING *
        """, (status, operation_id)).fetchone()
