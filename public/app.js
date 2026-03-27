let token = "";
let me = null;
let subscribersCache = [];
let recordsCache = [];
let settingsCache = null;

const el = (id) => document.getElementById(id);

let searchTimer = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

async function apiForm(path, formData) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: formData
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "حدث خطأ");
  return data;
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

function roleLabel(role) {
  if (role === "manager") return "مدير";
  if (role === "writer") return "كاتب";
  if (role === "collector") return "محصل";
  return role;
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
  el("welcomeText").textContent = `${me.name} - ${roleLabel(me.role)}`;
  el("loginCard").classList.add("hidden");
  el("appPanel").classList.remove("hidden");
  el("globalSearchWrap").classList.remove("hidden");
  if (me.role !== "manager") {
    el("usersTabBtn").classList.add("hidden");
    el("settingsTabBtn").classList.add("hidden");
  }
  if (!canEdit()) {
    el("addAreaBtn").disabled = true;
    el("addSubBtn").disabled = true;
    el("initYearBtn").disabled = true;
    if (el("importExcelBtn")) el("importExcelBtn").disabled = true;
    if (el("excelFile")) el("excelFile").disabled = true;
  }
  await loadSettings();
  await loadAreas();
  await loadSubscribers();
  if (me.role === "manager") {
    await loadUsers();
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

function populateBillingPlans() {
  const plans = settingsCache?.meter_plans || [];
  const opts = plans
    .map((p) => `<option value="${p.code}">${p.label} - ${formatNumber(p.water_price)}</option>`)
    .join("");
  el("subBillingPlan").innerHTML = opts;
  if (el("importBillingPlan")) el("importBillingPlan").innerHTML = opts;
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
        <td>${r.billing_plan_label || r.billing_plan || "-"}</td>
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
      billing_plan: el("subBillingPlan").value,
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
  const writers = users.filter((u) => u.role === "writer");
  const collectors = users.filter((u) => u.role === "collector");
  el("writersList").innerHTML = writers
    .map((u) => `<li>${u.name} - ${u.code}</li>`)
    .join("");
  el("collectorsList").innerHTML = collectors
    .map((u) => `<li>${u.name} - ${u.code}</li>`)
    .join("");
  el("assignWriter").innerHTML = writers
    .map((u) => `<option value="${u.id}">${u.name}</option>`)
    .join("");
  el("assignCollector").innerHTML = collectors
    .map((u) => `<option value="${u.id}">${u.name}</option>`)
    .join("");
  const subs = await api("/api/subscribers");
  const subOptions = subs
    .map((s) => `<option value="${s.id}">${s.subscriber_number} - ${s.owner_name}</option>`)
    .join("");
  el("assignSubWriter").innerHTML = subOptions;
  el("assignSubCollector").innerHTML = subOptions;
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
  settingsCache = s;
  el("cleanFee").value = s.cleaning_fee;
  el("interestRate").value = s.monthly_interest;
  drawPlans();
  populateBillingPlans();
}

function drawPlans() {
  const plans = settingsCache?.meter_plans || [];
  el("plansWrap").innerHTML = plans
    .map(
      (p, idx) => `<div class="grid plan-row">
        <input id="plan-label-${idx}" placeholder="اسم النظام" value="${p.label}" />
        <input id="plan-code-${idx}" placeholder="رمز النظام" value="${p.code}" />
        <input id="plan-price-${idx}" type="number" placeholder="سعر الماء" value="${p.water_price}" />
        <button onclick="removePlan(${idx})" class="danger">حذف</button>
      </div>`
    )
    .join("");
}

function removePlan(idx) {
  settingsCache.meter_plans.splice(idx, 1);
  drawPlans();
  populateBillingPlans();
}

function collectPlans() {
  const old = settingsCache?.meter_plans || [];
  return old
    .map((_, idx) => ({
      label: el(`plan-label-${idx}`)?.value?.trim() || "",
      code: el(`plan-code-${idx}`)?.value?.trim() || "",
      water_price: Number(el(`plan-price-${idx}`)?.value || 0)
    }))
    .filter((p) => p.label && p.code);
}

async function saveSettings() {
  const plans = collectPlans();
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      cleaning_fee: Number(el("cleanFee").value),
      monthly_interest: Number(el("interestRate").value),
      meter_plans: plans
    })
  });
  settingsCache.meter_plans = plans;
  populateBillingPlans();
  alert("تم حفظ الاعدادات");
}

async function assignSubscriber(subscriberId, userId, type) {
  await api(`/api/subscribers/${subscriberId}/assign`, {
    method: "POST",
    body: JSON.stringify({
      user_id: Number(userId),
      assignment_type: type
    })
  });
  alert("تم الربط بنجاح");
}

function addPlanRow() {
  if (!settingsCache) settingsCache = { meter_plans: [] };
  settingsCache.meter_plans.push({
    code: `plan${settingsCache.meter_plans.length + 1}`,
    label: "نظام جديد",
    water_price: 0
  });
  drawPlans();
}

el("loginBtn").onclick = () => login().catch((e) => alert(e.message));
el("logoutBtn").onclick = logout;
el("addAreaBtn").onclick = () => addArea().catch((e) => alert(e.message));
el("addSubBtn").onclick = () => addSubscriber().catch((e) => alert(e.message));
el("initYearBtn").onclick = () => initYear().catch((e) => alert(e.message));
el("loadYearBtn").onclick = () => loadRecords().catch((e) => alert(e.message));
el("addUserBtn").onclick = () => addUser().catch((e) => alert(e.message));
el("assignWriterBtn").onclick = () =>
  assignSubscriber(el("assignSubWriter").value, el("assignWriter").value, "writer").catch((e) => alert(e.message));
el("assignCollectorBtn").onclick = () =>
  assignSubscriber(el("assignSubCollector").value, el("assignCollector").value, "collector").catch((e) => alert(e.message));
el("saveSettingsBtn").onclick = () => saveSettings().catch((e) => alert(e.message));
el("addPlanBtn").onclick = addPlanRow;
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
window.removePlan = removePlan;

async function runGlobalSearch() {
  const q = el("globalSearch").value.trim();
  const box = el("searchResults");
  if (q.length < 1) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const parts = [];
  const pushSection = (label, items) => {
    if (!items.length) return;
    parts.push(`<div class="sr-sub" style="padding:6px 10px;background:#f1f5f9;">${escapeHtml(label)}</div>`);
    items.forEach((it) => {
      const sid = it.subscriber_id != null ? String(it.subscriber_id) : "";
      const yr = it.year != null ? String(it.year) : "";
      parts.push(
        `<button type="button" class="search-hit" data-type="${escapeHtml(it.type)}" data-id="${escapeHtml(
          String(it.id)
        )}" data-sid="${escapeHtml(sid)}" data-year="${escapeHtml(yr)}"><strong>${escapeHtml(it.title)}</strong><div class="sr-sub">${escapeHtml(
          it.subtitle || ""
        )}</div></button>`
      );
    });
  };
  pushSection("مناطق", data.areas || []);
  pushSection("مشتركين", data.subscribers || []);
  pushSection("موظفين", data.users || []);
  pushSection("وصول", data.records || []);
  if (!parts.length) {
    box.innerHTML = `<div class="sr-sub" style="padding:10px;">لا توجد نتائج</div>`;
  } else {
    box.innerHTML = parts.join("");
    box.querySelectorAll(".search-hit").forEach((btn) => {
      btn.onclick = () => {
        const t = btn.getAttribute("data-type");
        const sid = btn.getAttribute("data-sid");
        const yr = btn.getAttribute("data-year");
        if (t === "subscriber") {
          pickSubscriber(Number(btn.getAttribute("data-id")));
        } else if (t === "area") {
          showTab("areasTab");
        } else if (t === "user") {
          showTab("usersTab");
        } else if (t === "record" && sid) {
          el("recordSub").value = sid;
          if (yr) el("recordYear").value = yr;
          showTab("recordsTab");
          loadRecords().catch((e) => alert(e.message));
        }
        box.classList.add("hidden");
      };
    });
  }
  box.classList.remove("hidden");
}

async function importExcel() {
  const fileInput = el("excelFile");
  const file = fileInput.files?.[0];
  if (!file) {
    alert("اختر ملف Excel أولاً");
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  fd.append("billing_plan", el("importBillingPlan").value);
  fd.append("create_areas", el("importCreateAreas").checked ? "true" : "false");
  fd.append("skip_duplicates", el("importSkipDup").checked ? "true" : "false");
  const out = await apiForm("/api/subscribers/import", fd);
  const pre = el("importResult");
  pre.classList.remove("hidden");
  let text = `${out.message || "تم"}\n`;
  if (out.errors?.length) {
    text += `\nأخطاء:\n${out.errors.map((e) => `سطر ${e.row}: ${e.message}`).join("\n")}`;
  }
  pre.textContent = text;
  fileInput.value = "";
  await loadAreas();
  await loadSubscribers();
  if (me.role === "manager") await loadUsers();
}

el("globalSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runGlobalSearch().catch((e) => alert(e.message)), 280);
});

el("globalSearch").addEventListener("focus", () => {
  if (el("globalSearch").value.trim()) runGlobalSearch().catch(() => {});
});

document.addEventListener("click", (ev) => {
  const wrap = el("globalSearchWrap");
  if (!wrap || wrap.classList.contains("hidden")) return;
  if (!wrap.contains(ev.target)) el("searchResults").classList.add("hidden");
});

el("importExcelBtn").onclick = () => importExcel().catch((e) => alert(e.message));
