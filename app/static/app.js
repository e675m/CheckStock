const $ = (selector) => document.querySelector(selector);
const operationForm = $("#operation-form");
const warehouseForm = $("#warehouse-form");
const kinds = { receipt: "Приход", transfer: "Между ФФ", fbs: "FBS", fbo: "FBO" };
const actions = { send: "Отправить", cancel: "Отменить резерв", receive: "Подтвердить приёмку" };
let state;
let operationId;
let lastPayload;
let warehouseId;

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

async function api(path, method = "GET", data) {
  const response = await fetch("/api" + path, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : "Проверьте данные и повторите попытку.");
  }
  return response.json();
}

function notice(message, isError = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", isError);
}

function table(target, headers, rows, empty) {
  $(target).innerHTML = rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((title) => `<th scope="col">${title}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="empty">${empty}</p>`;
}

function warehouse(id) {
  return state.warehouses.find((item) => item.id === id);
}

function warehouseLabel(id) {
  const item = warehouse(id);
  return escapeHtml(item.name) + (item.archived ? ' <span class="pill">Архив</span>' : "");
}

function route(operation) {
  const origin = warehouseLabel(operation.warehouse_id);
  if (operation.kind === "receipt") return "Приход → " + origin;
  if (operation.kind === "transfer") return origin + " → " + warehouseLabel(operation.destination_id);
  return origin + (operation.kind === "fbo" ? " → склад маркетплейса" : " → клиент");
}

function renderBalances() {
  const search = $("#search").value.trim().toLowerCase();
  const rows = state.balances.filter((row) => {
    const item = state.products.find((product) => product.sku === row.sku);
    return (!warehouse(row.warehouse_id).archived || row.physical > 0)
      && (item.name + " " + row.sku).toLowerCase().includes(search);
  }).map((row) => {
    const item = state.products.find((product) => product.sku === row.sku);
    return `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(row.sku)}</small></td>
      <td>${warehouseLabel(row.warehouse_id)}</td><td class="num">${row.physical}</td>
      <td class="num">${row.physical - row.reserved}</td><td class="num">${row.reserved}</td></tr>`;
  });
  table("#balances", ["Товар", "Склад", "На складе", "Свободно на ФФ", "Резерв FBS"], rows, "Остатки не найдены.");
}

function render() {
  const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
  const transit = state.operations.filter((row) => row.status === "transit");
  const metrics = [
    ["Физически на ФФ", sum(state.balances, "physical")],
    ["Резерв FBS", sum(state.balances, "reserved")],
    ["Между ФФ", sum(transit.filter((row) => row.kind === "transfer"), "quantity")],
    ["На склад по FBO", sum(transit.filter((row) => row.kind === "fbo"), "quantity")],
    ["К клиенту по FBS", sum(transit.filter((row) => row.kind === "fbs"), "quantity")],
  ];
  $("#metrics").innerHTML = metrics.map(([label, number]) =>
    `<div class="metric"><small>${label}</small><strong>${number} <small>шт.</small></strong></div>`
  ).join("");
  renderBalances();
  table("#operations", ["Тип", "Артикул", "Маршрут", "Количество", "Статус", "Действия"],
    state.operations.map((row) => {
      const reserved = row.status === "reserved";
      const buttons = (reserved ? ["send", "cancel"] : ["receive"]).map((action) =>
        `<button class="secondary" data-operation="${row.id}" data-action="${action}">${actions[action]}</button>`
      ).join("");
      return `<tr><td>${kinds[row.kind]}</td><td>${escapeHtml(row.sku)}</td><td>${route(row)}</td>
        <td>${row.quantity}</td><td><span class="pill">${reserved ? "Резерв" : "В пути"}</span></td><td>${buttons}</td></tr>`;
    }), "Активных резервов и отправок пока нет.");
  table("#warehouse-list", ["Склад", "Физический остаток", "Действия"],
    state.warehouses.map((row) => {
      const buttons = row.archived ? "—" : `<button class="secondary" data-rename="${row.id}">Переименовать</button>
        <button class="secondary" data-archive="${row.id}">В архив</button>`;
      return `<tr><td>${warehouseLabel(row.id)}</td>
        <td>${sum(state.balances.filter((item) => item.warehouse_id === row.id), "physical")}</td><td>${buttons}</td></tr>`;
    }), "Добавьте первый склад.");
  const created = { receipt: "Принято на ФФ", transfer: "Отправлено между ФФ", fbs: "Зарезервировано", fbo: "Отправлено по FBO" };
  const eventLabels = { send: "Отправлено по FBS", cancel: "Резерв снят", receive: "Приёмка подтверждена" };
  table("#events", ["Время", "Операция", "Артикул", "Маршрут", "Количество"],
    state.history.map((row) => `<tr><td>${new Date(row.happened_at).toLocaleString("ru-RU")}</td>
      <td>${row.action === "created" ? created[row.kind] : eventLabels[row.action]}</td>
      <td>${escapeHtml(row.sku)}</td><td>${route(row)}</td><td>${row.quantity}</td></tr>`),
    "Операций пока нет.");
}

async function refresh() {
  state = await api("/state");
  render();
  $("#new-operation").disabled = false;
  $("#new-warehouse").disabled = false;
}

function populate(select, rows, value, label) {
  select.replaceChildren(...rows.map((row) => new Option(label(row), row[value])));
}

function operationFields() {
  const fields = operationForm.elements;
  const transfer = fields.kind.value === "transfer";
  const source = fields.warehouse_id.value;
  populate(fields.warehouse_id, state.warehouses.filter((row) => transfer || !row.archived),
    "id", (row) => row.name + (row.archived ? " (архив)" : ""));
  if ([...fields.warehouse_id.options].some((option) => option.value === source)) {
    fields.warehouse_id.value = source;
  }
  $("#destination").hidden = !transfer;
  fields.destination_id.required = transfer;
  const destination = fields.destination_id.value;
  populate(fields.destination_id, state.warehouses.filter((row) => !row.archived && String(row.id) !== fields.warehouse_id.value),
    "id", (row) => row.name);
  if ([...fields.destination_id.options].some((option) => option.value === destination)) {
    fields.destination_id.value = destination;
  }
}

$("#new-operation").onclick = () => {
  operationForm.reset();
  operationForm.querySelector(".form-error").textContent = "";
  lastPayload = undefined;
  populate(operationForm.elements.sku, state.products, "sku", (item) => `${item.sku} · ${item.name}`);
  operationFields();
  $("#operation-dialog").showModal();
};
operationForm.elements.kind.onchange = operationFields;
operationForm.elements.warehouse_id.onchange = operationFields;

function openWarehouse(id) {
  warehouseId = id;
  warehouseForm.querySelector("h2").textContent = id ? "Переименовать склад" : "Добавить склад";
  warehouseForm.elements.name.value = id ? warehouse(id).name : "";
  warehouseForm.querySelector(".form-error").textContent = "";
  $("#warehouse-dialog").showModal();
}

async function submit(form, action, message) {
  const error = form.querySelector(".form-error");
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  error.textContent = "";
  try {
    await action();
    form.closest("dialog").close();
    notice(message);
    await refresh();
  } catch (err) {
    if (form.closest("dialog").open) error.textContent = err.message;
    else notice(err.message, true);
  } finally {
    submitButton.disabled = false;
  }
}

operationForm.onsubmit = (event) => {
  event.preventDefault();
  const fields = new FormData(operationForm);
  const payload = {
    kind: fields.get("kind"), sku: fields.get("sku"), quantity: Number(fields.get("quantity")),
    warehouse_id: Number(fields.get("warehouse_id")),
    destination_id: fields.get("kind") === "transfer" ? Number(fields.get("destination_id")) : null,
  };
  const signature = JSON.stringify(payload);
  if (signature !== lastPayload) {
    operationId = crypto.randomUUID();
    lastPayload = signature;
  }
  submit(operationForm, () => api("/operations", "POST", { id: operationId, ...payload }), "Операция сохранена.");
};

warehouseForm.onsubmit = (event) => {
  event.preventDefault();
  const id = warehouseId;
  const data = { name: warehouseForm.elements.name.value };
  submit(warehouseForm, () => api(id ? "/warehouses/" + id : "/warehouses", id ? "PATCH" : "POST", data), "Склад сохранён.");
};

$("#search").oninput = () => { if (state) renderBalances(); };
$("#new-warehouse").onclick = () => openWarehouse();
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const { close, rename, archive, operation, action } = button.dataset;
  if (close !== undefined) button.closest("dialog").close();
  if (rename) openWarehouse(Number(rename));
  if (!archive && !operation) return;
  if (archive && !confirm("Перенести склад в архив? Остатки и история сохранятся.")) return;
  button.disabled = true;
  try {
    if (archive) await api("/warehouses/" + archive, "DELETE");
    else await api(`/operations/${operation}/${action}`, "POST");
    notice(archive ? "Склад перенесён в архив." : "Действие подтверждено.");
    await refresh();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

refresh().catch((error) => notice(error.message, true));
