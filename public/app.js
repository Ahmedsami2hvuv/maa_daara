let token = "";
let me = null;
let subscribersCache = [];
let recordsCache = [];
let settingsCache = null;
let selectedAreaId = null;
let forcedSubscribers = null;
let currentTabId = "areasTab";

const SESSION_KEY = "wbs_token";

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
  currentTabId = id;
}

function goBackInApp() {
  if (currentTabId === "recordsTab") {
    showTab("subsTab");
    loadSubscribers().catch((e) => alert(e.message));
    return;
  }
  if (
    currentTabId === "subsTab" ||
    currentTabId === "writersTab" ||
    currentTabId === "collectorsTab" ||
    currentTabId === "settingsTab"
  ) {
    showTab("areasTab");
    return;
  }
  if (currentTabId === "areasTab") {
    showTab("subsTab");
  }
}

function applyLoggedInUi() {
  el("welcomeText").textContent = `${me.name} - ${roleLabel(me.role)}`;
  el("loginCard").classList.add("hidden");
  el("appPanel").classList.remove("hidden");
  el("globalSearchWrap").classList.remove("hidden");
  if (el("appBackBtn")) el("appBackBtn").classList.remove("hidden");
  if (me.role !== "manager") {
    el("writersTabBtn").classList.add("hidden");
    el("collectorsTabBtn").classList.add("hidden");
    el("settingsTabBtn").classList.add("hidden");
  } else {
    el("writersTabBtn").classList.remove("hidden");
    el("collectorsTabBtn").classList.remove("hidden");
    el("settingsTabBtn").classList.remove("hidden");
  }
  if (!canEdit()) {
    el("addAreaBtn").disabled = true;
    el("addSubBtn").disabled = true;
    el("initYearBtn").disabled = true;
    if (el("importExcelBtn")) el("importExcelBtn").disabled = true;
    if (el("excelFile")) el("excelFile").disabled = true;
  } else {
    el("addAreaBtn").disabled = false;
    el("addSubBtn").disabled = false;
    el("initYearBtn").disabled = false;
    if (el("importExcelBtn")) el("importExcelBtn").disabled = false;
    if (el("excelFile")) el("excelFile").disabled = false;
  }
}

async function tryRestoreSession() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  token = saved;
  try {
    me = await api("/api/me");
    applyLoggedInUi();
    await loadSettings();
    await loadAreas();
    await loadSubscribers();
    if (me.role === "manager") {
      await loadUsers();
    }
  } catch (_e) {
    token = "";
    me = null;
    sessionStorage.removeItem(SESSION_KEY);
  }
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

function getCheckedValues(selector) {
  return [...document.querySelectorAll(selector)]
    .filter((x) => x.checked)
    .map((x) => Number(x.value))
    .filter((x) => Number.isFinite(x));
}

function setCheckedAll(selector, checked) {
  document.querySelectorAll(selector).forEach((x) => {
    x.checked = checked;
  });
}

function renderBulkLists(areas, subscribers) {
  const mkAreas = (cls) =>
    areas
      .map((a) => `<label><input type="checkbox" class="${cls}" value="${a.id}" /> ${escapeHtml(a.name)}</label>`)
      .join("");
  const mkSubs = (cls) =>
    subscribers
      .map(
        (s) =>
          `<label><input type="checkbox" class="${cls}" value="${s.id}" /> ${escapeHtml(
            `${s.subscriber_number} - ${s.owner_name} (${s.area_name || "-"})`
          )}</label>`
      )
      .join("");
  if (el("bulkAreasListWriters")) el("bulkAreasListWriters").innerHTML = mkAreas("bulk-area-writer");
  if (el("bulkSubsListWriters")) el("bulkSubsListWriters").innerHTML = mkSubs("bulk-sub-writer");
  if (el("bulkAreasListCollectors")) el("bulkAreasListCollectors").innerHTML = mkAreas("bulk-area-collector");
  if (el("bulkSubsListCollectors")) el("bulkSubsListCollectors").innerHTML = mkSubs("bulk-sub-collector");
}

function refreshBulkUsers(users) {
  const writers = users.filter((u) => u.role === "writer");
  const collectors = users.filter((u) => u.role === "collector");
  if (el("bulkUsersListWriters")) {
    el("bulkUsersListWriters").innerHTML = writers
      .map(
        (u) =>
          `<label><input type="checkbox" class="bulk-user-writer" value="${u.id}" /> ${escapeHtml(u.name)} - ${escapeHtml(
            u.code
          )}</label>`
      )
      .join("");
  }
  if (el("bulkUsersListCollectors")) {
    el("bulkUsersListCollectors").innerHTML = collectors
      .map(
        (u) =>
          `<label><input type="checkbox" class="bulk-user-collector" value="${u.id}" /> ${escapeHtml(u.name)} - ${escapeHtml(
            u.code
          )}</label>`
      )
      .join("");
  }
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
  sessionStorage.setItem(SESSION_KEY, token);
  applyLoggedInUi();
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
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}

async function loadAreas() {
  const areas = await api("/api/areas");
  el("areasList").innerHTML = areas
    .map(
      (a) =>
        `<li><button type="button" class="link-btn" onclick="openAreaSubscribers(${a.id})">${escapeHtml(a.name)}</button></li>`
    )
    .join("");
  const opts = areas.map((a) => `<option value="${a.id}">${a.name}</option>`).join("");
  el("subArea").innerHTML = opts;
  if (el("editAreaSelect")) el("editAreaSelect").innerHTML = opts;
  if (el("editSubArea")) el("editSubArea").innerHTML = opts;
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

async function saveAreaEdit() {
  const id = Number(el("editAreaSelect").value);
  const name = el("editAreaName").value.trim();
  await api(`/api/areas/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name })
  });
  el("editAreaName").value = "";
  await loadAreas();
  await loadSubscribers();
  alert("تم تعديل اسم المنطقة");
}

function subscriberRowClick(ev, id) {
  if (ev.target.closest(".sub-chk-col") || ev.target.closest("input[type=checkbox]")) return;
  pickSubscriber(id);
}

async function loadSubscribers() {
  const rows = await api("/api/subscribers");
  subscribersCache = rows;
  let shown = rows;
  if (forcedSubscribers) {
    shown = forcedSubscribers;
  } else if (selectedAreaId) {
    shown = rows.filter((r) => Number(r.area_id) === Number(selectedAreaId));
  }
  const showBulk = canEdit();
  if (el("subsBulkBar")) el("subsBulkBar").classList.toggle("hidden", !showBulk);
  if (el("subsBulkHint") && showBulk) {
    el("subsBulkHint").textContent =
      shown.length > 0 ? `عرض ${shown.length} مشترك${selectedAreaId ? " (منطقة محددة)" : ""}` : "";
  }
  const chkCell = (r) =>
    showBulk
      ? `<td class="sub-chk-col" onclick="event.stopPropagation()"><input type="checkbox" class="sub-select" value="${r.id}" /></td>`
      : `<td class="sub-chk-col"></td>`;
  el("subsBody").innerHTML = shown
    .map(
      (r) => `<tr class="subscriber-row" onclick="subscriberRowClick(event, ${r.id})" title="افتح السجل السنوي">
        ${chkCell(r)}
        <td>${escapeHtml(String(r.area_name || ""))}</td>
        <td>${escapeHtml(String(r.subscriber_number || ""))}</td>
        <td>${escapeHtml(String(r.owner_name || ""))}</td>
        <td>${escapeHtml(String(r.subscriber_type || "-"))}</td>
        <td>${escapeHtml(String(r.phone || "-"))}</td>
        <td>${escapeHtml(String(r.billing_plan_label || r.billing_plan || "-"))}</td>
        <td>افتح</td>
      </tr>`
    )
    .join("");
  const tbl = el("subsBody")?.closest("table");
  if (tbl) tbl.classList.toggle("subs-no-bulk", !showBulk);
  if (el("subsSelectAll")) el("subsSelectAll").checked = false;
  el("recordSub").innerHTML = shown
    .map((r) => `<option value="${r.id}">${r.subscriber_number} - ${r.owner_name}</option>`)
    .join("");
  if (el("editSubSelect")) {
    el("editSubSelect").innerHTML = shown
      .map((r) => `<option value="${r.id}">${r.subscriber_number} - ${r.owner_name}</option>`)
      .join("");
  }
  if (el("subsViewHint")) {
    if (forcedSubscribers) el("subsViewHint").classList.remove("hidden");
    else el("subsViewHint").classList.add("hidden");
  }
}

async function openAreaSubscribers(areaId) {
  forcedSubscribers = null;
  if (el("subsViewHint")) el("subsViewHint").classList.add("hidden");
  selectedAreaId = Number(areaId);
  showTab("subsTab");
  if (el("subArea")) el("subArea").value = String(areaId);
  await loadSubscribers();
}

async function openUserAssignedSubscribers(userId) {
  selectedAreaId = null;
  const out = await api(`/api/users/${Number(userId)}/subscribers`);
  forcedSubscribers = out.subscribers || [];
  const roleText = roleLabel(out.user?.role || "");
  if (el("subsViewHint")) {
    el("subsViewHint").textContent = `عرض مشتركين ${roleText}: ${out.user?.name || "-"} (${forcedSubscribers.length})`;
    el("subsViewHint").classList.remove("hidden");
  }
  showTab("subsTab");
  await loadSubscribers();
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
      subscriber_type: el("subType").value,
      phone: el("subPhone").value.trim() || null,
      billing_plan: el("subBillingPlan").value,
      previousOwners
    })
  });
  el("subNumber").value = "";
  el("subOwner").value = "";
  el("subType").value = "منزلي";
  el("subPhone").value = "";
  el("subPrevOwners").value = "";
  await loadSubscribers();
}

async function loadSubscriberForEdit() {
  const id = Number(el("editSubSelect").value);
  const out = await api(`/api/subscribers/${id}/details`);
  const s = out.subscriber;
  el("editSubArea").value = String(s.area_id);
  el("editSubNumber").value = s.subscriber_number || "";
  el("editSubOwner").value = s.owner_name || "";
  el("editSubType").value = s.subscriber_type || "منزلي";
  el("editSubPhone").value = s.phone || "";
  el("editSubBillingPlan").innerHTML = el("subBillingPlan").innerHTML;
  el("editSubBillingPlan").value = s.billing_plan || "";
  el("prevOwnersList").innerHTML = (out.previousOwners || [])
    .map((p) => `<li>${escapeHtml(p.owner_name)}</li>`)
    .join("");
}

async function saveSubscriberEdit() {
  const id = Number(el("editSubSelect").value);
  await api(`/api/subscribers/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      area_id: Number(el("editSubArea").value),
      subscriber_number: el("editSubNumber").value.trim(),
      owner_name: el("editSubOwner").value.trim(),
      subscriber_type: el("editSubType").value,
      phone: el("editSubPhone").value.trim() || null,
      billing_plan: el("editSubBillingPlan").value
    })
  });
  await loadSubscribers();
  await loadSubscriberForEdit();
  alert("تم تعديل بيانات المشترك");
}

async function addPreviousOwnerToSubscriber() {
  const id = Number(el("editSubSelect").value);
  const ownerName = el("newPrevOwner").value.trim();
  await api(`/api/subscribers/${id}/previous-owners`, {
    method: "POST",
    body: JSON.stringify({ owner_name: ownerName })
  });
  el("newPrevOwner").value = "";
  await loadSubscriberForEdit();
  alert("تمت إضافة مالك سابق");
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
        <td><input type="number" value="${Number(r.other || 0)}" id="other-${r.id}" ${canEdit() ? "" : "disabled"} /></td>
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
      other: Number(el(`other-${id}`).value || 0),
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
    "وصل جباية الماء",
    "------------------------------------",
    `رقم المشترك: ${subscriber?.subscriber_number || "-"}`,
    `اسم المالك: ${subscriber?.owner_name || "-"}`,
    `المنطقة: ${subscriber?.area_name || "-"}`,
    `السنة: ${year}`,
    `الفترة: ${row?.date_from || "-"} -> ${row?.date_to || "-"}`,
    "------------------------------------",
    `الماء: ${formatNumber(row?.water)}`,
    `التنظيف: ${formatNumber(row?.cleaning)}`,
    `الفائدة: ${formatNumber(row?.interest)}`,
    `اخرى: ${formatNumber(row?.other)}`,
    `المجموع: ${formatNumber(row?.subtotal)}`,
    `الديون: ${formatNumber(row?.debt)}`,
    `المجموع الكلي: ${formatNumber(row?.total_due)}`,
    `المدفوع: ${formatNumber(row?.paid)}`,
    `المتبقي: ${formatNumber(Number(row?.total_due || 0) - Number(row?.paid || 0))}`,
    "------------------------------------",
    `رقم الوصل: ${row?.receipt_number || "-"}`,
    `تاريخ الوصل: ${row?.receipt_date || "-"}`,
    `وقت الطباعة: ${new Date().toLocaleString("ar-IQ")}`
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
    .map(
      (u) =>
        `<li><button type="button" class="link-btn" onclick="openUserAssignedSubscribers(${u.id})">${escapeHtml(
          u.name
        )}</button> - ${escapeHtml(u.code)}</li>`
    )
    .join("");
  el("collectorsList").innerHTML = collectors
    .map(
      (u) =>
        `<li><button type="button" class="link-btn" onclick="openUserAssignedSubscribers(${u.id})">${escapeHtml(
          u.name
        )}</button> - ${escapeHtml(u.code)}</li>`
    )
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
  const areas = await api("/api/areas");
  renderBulkLists(areas, subs);
  refreshBulkUsers(users);
}

async function addWriter() {
  await api("/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: el("writerUserName").value.trim(),
      role: "writer",
      code: el("writerUserCode").value.trim(),
      pin: el("writerUserPin").value.trim()
    })
  });
  el("writerUserName").value = "";
  el("writerUserCode").value = "";
  el("writerUserPin").value = "";
  await loadUsers();
}

async function addCollector() {
  await api("/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: el("collectorUserName").value.trim(),
      role: "collector",
      code: el("collectorUserCode").value.trim(),
      pin: el("collectorUserPin").value.trim()
    })
  });
  el("collectorUserName").value = "";
  el("collectorUserCode").value = "";
  el("collectorUserPin").value = "";
  await loadUsers();
}

async function loadSettings() {
  const s = await api("/api/settings");
  settingsCache = s;
  el("cleanFee").value = s.cleaning_fee;
  el("interestRate").value = s.monthly_interest;
  if (el("otherFee")) el("otherFee").value = Number(s.other_fee || 24600);
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
      other_fee: Number(el("otherFee").value || 0),
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

async function bulkAssignWriters() {
  const userIds = getCheckedValues(".bulk-user-writer");
  const areaIds = getCheckedValues(".bulk-area-writer");
  const subscriberIds = getCheckedValues(".bulk-sub-writer");
  const out = await api("/api/assignments/bulk", {
    method: "POST",
    body: JSON.stringify({
      user_ids: userIds,
      assignment_type: "writer",
      area_ids: areaIds,
      subscriber_ids: subscriberIds
    })
  });
  alert(`تم الإسناد بنجاح لعدد ${out.users_count} كاتب. أُضيف ${out.added} ربط جديد.`);
}

async function bulkAssignCollectors() {
  const userIds = getCheckedValues(".bulk-user-collector");
  const areaIds = getCheckedValues(".bulk-area-collector");
  const subscriberIds = getCheckedValues(".bulk-sub-collector");
  const out = await api("/api/assignments/bulk", {
    method: "POST",
    body: JSON.stringify({
      user_ids: userIds,
      assignment_type: "collector",
      area_ids: areaIds,
      subscriber_ids: subscriberIds
    })
  });
  alert(`تم الإسناد بنجاح لعدد ${out.users_count} محصل. أُضيف ${out.added} ربط جديد.`);
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

async function bulkDeleteSelected() {
  const ids = [...document.querySelectorAll("#subsBody .sub-select:checked")].map((x) => Number(x.value));
  if (!ids.length) {
    alert("حدد مشتركاً واحداً على الأقل");
    return;
  }
  if (!confirm(`حذف ${ids.length} مشترك نهائياً مع سجلاتهم وربطهم؟`)) return;
  const out = await api("/api/subscribers/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
  if (el("subsSelectAll")) el("subsSelectAll").checked = false;
  await loadSubscribers();
  if (me.role === "manager") await loadUsers();
  alert(`تم حذف ${out.removed} مشترك`);
}

el("loginBtn").onclick = () => login().catch((e) => alert(e.message));
el("logoutBtn").onclick = logout;
el("addAreaBtn").onclick = () => addArea().catch((e) => alert(e.message));
el("saveAreaEditBtn").onclick = () => saveAreaEdit().catch((e) => alert(e.message));
el("addSubBtn").onclick = () => addSubscriber().catch((e) => alert(e.message));
el("loadSubEditBtn").onclick = () => loadSubscriberForEdit().catch((e) => alert(e.message));
el("saveSubEditBtn").onclick = () => saveSubscriberEdit().catch((e) => alert(e.message));
el("addPrevOwnerBtn").onclick = () => addPreviousOwnerToSubscriber().catch((e) => alert(e.message));
el("initYearBtn").onclick = () => initYear().catch((e) => alert(e.message));
el("loadYearBtn").onclick = () => loadRecords().catch((e) => alert(e.message));
el("addWriterBtn").onclick = () => addWriter().catch((e) => alert(e.message));
el("addCollectorBtn").onclick = () => addCollector().catch((e) => alert(e.message));
el("assignWriterBtn").onclick = () =>
  assignSubscriber(el("assignSubWriter").value, el("assignWriter").value, "writer").catch((e) => alert(e.message));
el("assignCollectorBtn").onclick = () =>
  assignSubscriber(el("assignSubCollector").value, el("assignCollector").value, "collector").catch((e) => alert(e.message));
el("bulkAssignWritersBtn").onclick = () => bulkAssignWriters().catch((e) => alert(e.message));
el("bulkAssignCollectorsBtn").onclick = () => bulkAssignCollectors().catch((e) => alert(e.message));
el("selectAllAreasBtnWriters").onclick = () => setCheckedAll(".bulk-area-writer", true);
el("clearAreasBtnWriters").onclick = () => setCheckedAll(".bulk-area-writer", false);
el("selectAllSubsBtnWriters").onclick = () => setCheckedAll(".bulk-sub-writer", true);
el("clearSubsBtnWriters").onclick = () => setCheckedAll(".bulk-sub-writer", false);
el("selectAllAreasBtnCollectors").onclick = () => setCheckedAll(".bulk-area-collector", true);
el("clearAreasBtnCollectors").onclick = () => setCheckedAll(".bulk-area-collector", false);
el("selectAllSubsBtnCollectors").onclick = () => setCheckedAll(".bulk-sub-collector", true);
el("clearSubsBtnCollectors").onclick = () => setCheckedAll(".bulk-sub-collector", false);
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
  btn.onclick = () => {
    if (btn.dataset.tab === "subsTab") {
      forcedSubscribers = null;
      if (el("subsViewHint")) el("subsViewHint").classList.add("hidden");
      loadSubscribers().catch((e) => alert(e.message));
    }
    if (btn.dataset.tab === "writersTab" || btn.dataset.tab === "collectorsTab") {
      loadUsers().catch((e) => alert(e.message));
    }
    showTab(btn.dataset.tab);
  };
});

window.pickSubscriber = pickSubscriber;
window.saveRecord = saveRecord;
window.removePlan = removePlan;
window.openAreaSubscribers = (areaId) => {
  openAreaSubscribers(areaId).catch((e) => alert(e.message));
};
window.openUserAssignedSubscribers = (userId) => {
  openUserAssignedSubscribers(userId).catch((e) => alert(e.message));
};

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
        )}" data-sid="${escapeHtml(sid)}" data-year="${escapeHtml(yr)}" data-role="${escapeHtml(
          it.role || ""
        )}"><strong>${escapeHtml(it.title)}</strong><div class="sr-sub">${escapeHtml(
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
          const role = btn.getAttribute("data-role") || "";
          if (role === "collector") showTab("collectorsTab");
          else showTab("writersTab");
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

if (el("appBackBtn")) el("appBackBtn").onclick = () => goBackInApp();
if (el("recordsBackBtn")) {
  el("recordsBackBtn").onclick = () => {
    showTab("subsTab");
    loadSubscribers().catch((e) => alert(e.message));
  };
}
if (el("subsBulkDeleteBtn")) el("subsBulkDeleteBtn").onclick = () => bulkDeleteSelected().catch((e) => alert(e.message));
if (el("subsSelectAll")) {
  el("subsSelectAll").addEventListener("change", () => {
    const on = el("subsSelectAll").checked;
    document.querySelectorAll("#subsBody .sub-select").forEach((x) => {
      x.checked = on;
    });
  });
}

window.subscriberRowClick = subscriberRowClick;

tryRestoreSession().catch(() => {});
