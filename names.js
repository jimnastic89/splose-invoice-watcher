// names.js
// Invoices only carry patientId and a nullable contactId — no display name.
// The API has no "fetch these specific ids" filter for /patients or
// /contacts, only pagination and search-by-firstname/lastname/email. So
// rather than issue a lookup per invoice (which would multiply our call
// count with every poll), we periodically pull the *entire* patient and
// contact lists once, cache them by id, and reuse that cache across polls.
//
// This trades a small amount of staleness (a brand-new patient's name
// might not resolve until the next cache rebuild) for a big reduction in
// API calls — appropriate given Splose's 60/minute limit and the fact
// that names change far less often than invoice status does.

import { fetchAllPages } from "./api.js";

const REBUILD_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

function displayNameFromPatient(p) {
  return [p.preferredName || p.firstname, p.lastname].filter(Boolean).join(" ") || "Unknown patient";
}

function displayNameFromContact(c) {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "Unknown contact";
}

async function rebuildCache({ apiKey }) {
  const [patients, contacts] = await Promise.all([
    fetchAllPages("/patients", { apiKey }),
    fetchAllPages("/contacts", { apiKey }),
  ]);

  const patientNames = {};
  for (const p of patients) patientNames[String(p.id)] = displayNameFromPatient(p);

  const contactNames = {};
  for (const c of contacts) contactNames[String(c.id)] = displayNameFromContact(c);

  const cache = { patientNames, contactNames, builtAt: Date.now() };
  await chrome.storage.local.set({ nameCache: cache });
  return cache;
}

async function getCache({ apiKey }, { forceRebuild = false } = {}) {
  const { nameCache } = await chrome.storage.local.get("nameCache");
  const stale = !nameCache || Date.now() - nameCache.builtAt > REBUILD_INTERVAL_MS;

  if (forceRebuild || stale) {
    try {
      return await rebuildCache({ apiKey });
    } catch (err) {
      console.error("Name cache rebuild failed, falling back to stale/empty cache:", err);
      return nameCache || { patientNames: {}, contactNames: {}, builtAt: 0 };
    }
  }
  return nameCache;
}

/**
 * Resolves a display name for an invoice: prefer the billed contact (if
 * one is set), otherwise fall back to the patient themselves.
 */
export async function resolveInvoiceContactName(invoice, config) {
  const cache = await getCache(config);
  if (invoice.contactId && cache.contactNames[invoice.contactId]) {
    return cache.contactNames[invoice.contactId];
  }
  if (invoice.patientId && cache.patientNames[invoice.patientId]) {
    return cache.patientNames[invoice.patientId];
  }
  return "Unknown client";
}

/**
 * Enriches a whole batch of invoices at once, rebuilding the cache at
 * most once per call (not once per invoice).
 */
export async function attachContactNames(invoices, config) {
  const cache = await getCache(config);
  return invoices.map((inv) => {
    const contactName =
      (inv.contactId && cache.contactNames[inv.contactId]) ||
      (inv.patientId && cache.patientNames[inv.patientId]) ||
      "Unknown client";
    return { ...inv, contactName };
  });
}
