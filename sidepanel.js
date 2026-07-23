import { getConfig } from "./config.js";

const listEl = document.getElementById("invoiceList");
const countPill = document.getElementById("countPill");
const statusDot = document.getElementById("statusDot");
const emptyState = document.getElementById("emptyState");
const unconfiguredState = document.getElementById("unconfiguredState");
const lastChecked = document.getElementById("lastChecked");
const collapseBtn = document.getElementById("toggleBtn");
const collapseIcon = document.getElementById("toggleIcon");
const collapsedBar = document.getElementById("collapsedBar");
const collapsedText = document.getElementById("collapsedText");
const content = document.getElementById("content");
const openOptionsBtn = document.getElementById("openOptionsBtn");

openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

function ageInDays(invoice) {
  const anchor = invoice.dueDate || invoice.issuedDate;
  if (!anchor) return 0;
  return Math.floor((Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24));
}

function formatAmount(invoice) {
  if (invoice.amountDue == null) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency || "AUD" })
    .format(invoice.amountDue);
}

async function render() {
  const config = await getConfig();
  const { trackedInvoices = {}, lastPolledAt } = await chrome.storage.local.get([
    "trackedInvoices",
    "lastPolledAt",
  ]);

  if (!config.apiKey || !config.subdomain) {
    unconfiguredState.hidden = false;
    emptyState.hidden = true;
    listEl.innerHTML = "";
    countPill.textContent = "0";
    countPill.classList.add("zero");
    statusDot.className = "dot";
    return;
  }
  unconfiguredState.hidden = true;

  const invoices = Object.values(trackedInvoices).sort((a, b) => ageInDays(b) - ageInDays(a));

  countPill.textContent = String(invoices.length);
  countPill.classList.toggle("zero", invoices.length === 0);
  statusDot.className = "dot " + (invoices.length ? "flagged" : "ok");
  collapsedText.textContent = `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"}`;

  emptyState.hidden = invoices.length !== 0;
  listEl.innerHTML = "";

  for (const inv of invoices) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "invoice-row";
    btn.innerHTML = `
      <div class="invoice-row-top">
        <span class="invoice-contact"></span>
        <span class="invoice-amount"></span>
      </div>
      <div class="invoice-row-bottom">
        <span class="invoice-number"></span>
        <span class="age-badge"></span>
      </div>
    `;
    btn.querySelector(".invoice-contact").textContent = inv.contactName || "Unknown client";
    btn.querySelector(".invoice-amount").textContent = formatAmount(inv);
    btn.querySelector(".invoice-number").textContent = inv.number ? `Invoice ${inv.number}` : "";
    const days = ageInDays(inv);
    btn.querySelector(".age-badge").textContent = `${days}d overdue`;
    btn.addEventListener("click", () => openInvoice(inv.url));
    li.appendChild(btn);
    listEl.appendChild(li);
  }

  lastChecked.textContent = lastPolledAt
    ? `Last checked ${new Date(lastPolledAt).toLocaleTimeString()}`
    : "Waiting for first check…";
}

async function openInvoice(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.update(tab.id, { url });
  } else {
    chrome.tabs.create({ url });
  }
}

// --- Collapse / minimise -----------------------------------------------
async function applyCollapsed(collapsed) {
  content.hidden = collapsed;
  collapsedBar.hidden = !collapsed;
  collapseIcon.textContent = collapsed ? "▸" : "▾";
  collapseBtn.title = collapsed ? "Expand" : "Minimise";
}

collapseBtn.addEventListener("click", async () => {
  const { panelCollapsed } = await chrome.storage.local.get("panelCollapsed");
  const next = !panelCollapsed;
  await chrome.storage.local.set({ panelCollapsed: next });
  applyCollapsed(next);
});

(async () => {
  const { panelCollapsed } = await chrome.storage.local.get("panelCollapsed");
  applyCollapsed(!!panelCollapsed);
})();

// --- Live updates ---------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.trackedInvoices || changes.lastPolledAt || changes.apiKey || changes.subdomain)) {
    render();
  }
});

render();
