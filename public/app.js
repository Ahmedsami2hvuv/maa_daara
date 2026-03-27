let token = "";
let me = null;
let subscribersCache = [];
let recordsCache = [];

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "حدث خطأ");
  }
  return res.json();
}

async function downloadApi(path) {
  const res = await fetch(path, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!res.ok) throw new Error("فشل تحميل الملف");
  return res.blob();
}

function showTab(id) {
  document.querySelectorAll(".tab").forEach((n) => n.classList.add("hidden"));
  el(id).classList.remove("hidden");
}

function canEdit() {
  return me && (me.role === "manager" || me.role === "writer");
}

async function login() {
  const code = el("code").value.trim();
  const pin = el("pin").value.trim();
  const out = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ code, pin })
  });
  token = out.token;
  me = out.user;
  el("welcomeText").textContent = `${me.name} - ${me.role}`;
  el("loginCard").classList.add("hidden");
  el("appPanel").classList.remove("hidden");
  if (me.role !== "manager") {
    el("usersTabBtn").classList.add("hidden");
    el("settingsTabBtn").classList.add("hidden");
  }
  if (!canEdit()) {
    el("addAreaBtn").disabled = true;
    el("addSubBtn").disabled = true;
    el("initYearBtn").disabled = true;
  }
  await loadAreas();
  await loadSubscribers();
  if (me.role === "manager") {
    await loadUsers();
    await loadSettings();
  }
}

function logout() {
  token = "";
  me = null;
  location.reload();
}

async function loadAreas() {
  const areas = await api("/api/areas");
  el("areasList").innerHTML = areas.map((a) => `<li>${a.name}</li>`).join("");
  el("subArea").innerHTML = areas.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
}

async function addArea() {
  await api("/api/areas", {
    method: "POST",
    body: JSON.stringify({ name: el("areaName").value.trim() })
  });
  el("areaName").value = "";
  await loadAreas();
}

async function loadSubscribers() {
  const rows = await api("/api/subscribers");
  subscribersCache = rows;
  el("subsBody").innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.area_name}</td>
        <td>${r.subscriber_number}</td>
        <td>${r.owner_name}</td>
        <td>${r.phone || "-"}</td>
        <td>${r.meter_size} متر</td>
        <td><button onclick="pickSubscriber(${r.id})">اختيار</button></td>
      </tr>`
    )
    .join("");
  el("recordSub").innerHTML = rows
    .map((r) => `<option value="${r.id}">${r.subscriber_number} - ${r.owner_name}</option>`)
    .join("");
}

async function addSubscriber() {
  const previousOwners = el("subPrevOwners")
    .value.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  await api("/api/subscribers", {
    method: "POST",
    body: JSON.stringify({
      area_id: Number(el("subArea").value),
      subscriber_number: el("subNumber").value.trim(),
      owner_name: el("subOwner").value.trim(),
      phone: el("subPhone").value.trim() || null,
      meter_size: Number(el("subMeter").value),
      previousOwners
    })
  });
  el("subNumber").value = "";
  el("subOwner").value = "";
  el("subPhone").value = "";
  el("subPrevOwners").value = "";
  await loadSubscribers();
}

function pickSubscriber(id) {
  el("recordSub").value = String(id);
  showTab("recordsTab");
}

async function initYear() {
  const id = Number(el("recordSub").value);
  const year = Number(el("recordYear").value);
  await api(`/api/subscribers/${id}/records/${year}/init`, { method: "POST" });
  await loadRecords();
}

async function loadRecords() {
  const id = Number(el("recordSub").value);
  const year = Number(el("recordYear").value);
  const rows = await api(`/api/subscribers/${id}/records/${year}`);
  recordsCache = rows;
  el("recordsBody").innerHTML = rows
    .map(
      (r) => `<tr>
        <td><input value="${r.date_from || ""}" id="from-${r.id}" /></td>
        <td><input value="${r.date_to || ""}" id="to-${r.id}" /></td>
        <td><input type="number" value="${r.water}" id="water-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
        <td><input type="number" value="${r.cleaning}" id="clean-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
        <td><input type="number" value="${r.interest}" id="interest-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
        <td>${r.subtotal.toFixed(0)}</td>
        <td>${r.debt.toFixed(0)}</td>
        <td>${r.total_due.toFixed(0)}</td>
        <td><input type="number" value="${r.paid}" id="paid-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
        <td><input value="${r.receipt_number || ""}" id="recno-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
        <td><input type="date" value="${r.receipt_date || ""}" id="recdate-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
        <td>${canEdit() ? `<button onclick="saveRecord(${r.id})">حفظ</button>` : "-"}</td>
      </tr>`
    )
    .join("");
}

async function saveRecord(id) {
  await api(`/api/records/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      date_from: el(`from-${id}`).value,
      date_to: el(`to-${id}`).value,
      water: Number(el(`water-${id}`).value || 0),
      cleaning: Number(el(`clean-${id}`).value || 0),
      interest: Number(el(`interest-${id}`).value || 0),
      paid: Number(el(`paid-${id}`).value || 0),
      receipt_number: el(`recno-${id}`).value || null,
      receipt_date: el(`recdate-${id}`).value || null
    })
  });
  await loadRecords();
}

async function downloadBackup() {
  const blob = await downloadApi("/api/backup");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `water-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function restoreBackup(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_e) {
    throw new Error("ملف JSON غير صحيح");
  }
  const out = await api("/api/restore", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  alert(out.message || "تم الاسترجاع بنجاح");
  logout();
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString("en-US");
}

function buildReceiptText(subscriber, year, row) {
  return [
    "Water Billing Receipt",
    "------------------------------------",
    `Subscriber No: ${subscriber?.subscriber_number || "-"}`,
    `Owner: ${subscriber?.owner_name || "-"}`,
    `Area: ${subscriber?.area_name || "-"}`,
    `Year: ${year}`,
    `Period: ${row?.date_from || "-"} -> ${row?.date_to || "-"}`,
    "------------------------------------",
    `Water: ${formatNumber(row?.water)}`,
    `Cleaning: ${formatNumber(row?.cleaning)}`,
    `Interest: ${formatNumber(row?.interest)}`,
    `Subtotal: ${formatNumber(row?.subtotal)}`,
    `Debt: ${formatNumber(row?.debt)}`,
    `Total Due: ${formatNumber(row?.total_due)}`,
    `Paid: ${formatNumber(row?.paid)}`,
    "------------------------------------",
    `Receipt No: ${row?.receipt_number || "-"}`,
    `Receipt Date: ${row?.receipt_date || "-"}`,
    `Printed At: ${new Date().toLocaleString()}`
  ];
}

async function printReceiptPdf() {
  if (!recordsCache.length) {
    await loadRecords();
  }
  const selected = recordsCache.find((r) => Number(r.paid || 0) > 0) || recordsCache[0];
  if (!selected) {
    alert("ماكو سجل حتى نطبع وصل");
    return;
  }
  const subId = Number(el("recordSub").value);
  const year = Number(el("recordYear").value);
  const subscriber = subscribersCache.find((s) => s.id === subId);

  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    alert("مكتبة PDF غير محملة");
    return;
  }
  const pdf = new jsPDFCtor({ unit: "pt", format: "a4" });
  pdf.setFont("courier", "normal");
  pdf.setFontSize(12);
  const lines = buildReceiptText(subscriber, year, selected);
  let y = 60;
  lines.forEach((line) => {
    pdf.text(line, 40, y);
    y += 20;
  });
  pdf.save(`receipt-${subscriber?.subscriber_number || "unknown"}-${year}.pdf`);
}

async function loadUsers() {
  const users = await api("/api/users");
  el("usersList").innerHTML = users
    .map((u) => `<li>${u.name} - ${u.role} - ${u.code}</li>`)
    .join("");
  el("assignUser").innerHTML = users
    .filter((u) => u.role === "writer" || u.role === "collector")
    .map((u) => `<option value="${u.id}">${u.name} (${u.role})</option>`)
    .join("");
  const subs = await api("/api/subscribers");
  el("assignSub").innerHTML = subs
    .map((s) => `<option value="${s.id}">${s.subscriber_number} - ${s.owner_name}</option>`)
    .join("");
}

async function addUser() {
  await api("/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: el("userName").value.trim(),
      role: el("userRole").value,
      code: el("userCode").value.trim(),
      pin: el("userPin").value.trim()
    })
  });
  el("userName").value = "";
  el("userCode").value = "";
  el("userPin").value = "";
  await loadUsers();
}

async function loadSettings() {
  const s = await api("/api/settings");
  el("price3").value = s.price_3m;
  el("price4").value = s.price_4m;
  el("cleanFee").value = s.cleaning_fee;
  el("interestRate").value = s.monthly_interest;
}

async function saveSettings() {
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      price_3m: Number(el("price3").value),
      price_4m: Number(el("price4").value),
      cleaning_fee: Number(el("cleanFee").value),
      monthly_interest: Number(el("interestRate").value)
    })
  });
  alert("تم حفظ الاعدادات");
}

async function assignSubscriber() {
  await api(`/api/subscribers/${Number(el("assignSub").value)}/assign`, {
    method: "POST",
    body: JSON.stringify({
      user_id: Number(el("assignUser").value),
      assignment_type: el("assignType").value
    })
  });
  alert("تم الربط بنجاح");
}

el("loginBtn").onclick = () => login().catch((e) => alert(e.message));
el("logoutBtn").onclick = logout;
el("addAreaBtn").onclick = () => addArea().catch((e) => alert(e.message));
el("addSubBtn").onclick = () => addSubscriber().catch((e) => alert(e.message));
el("initYearBtn").onclick = () => initYear().catch((e) => alert(e.message));
el("loadYearBtn").onclick = () => loadRecords().catch((e) => alert(e.message));
el("addUserBtn").onclick = () => addUser().catch((e) => alert(e.message));
el("assignBtn").onclick = () => assignSubscriber().catch((e) => alert(e.message));
el("saveSettingsBtn").onclick = () => saveSettings().catch((e) => alert(e.message));
el("downloadBackupBtn").onclick = () => downloadBackup().catch((e) => alert(e.message));
el("printReceiptBtn").onclick = () => printReceiptPdf().catch((e) => alert(e.message));
el("restoreFile").onchange = (evt) => {
  const file = evt.target.files?.[0];
  if (!file) return;
  restoreBackup(file).catch((e) => alert(e.message));
};

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.onclick = () => showTab(btn.dataset.tab);
});

window.pickSubscriber = pickSubscriber;
window.saveRecord = saveRecord;
