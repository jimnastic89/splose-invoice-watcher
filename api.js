// api.js
// Thin client for the Splose API, matched against the OpenAPI spec you
// provided. Key confirmed facts that shaped this file:
//
// - Fixed API host for everyone: https://api.splose.com/v1 — NOT a
//   per-business subdomain. (The business subdomain, e.g.
//   https://<business>.splose.com, is a separate thing: it's the web app
//   URL used to build a clickable link to an invoice. That format wasn't
//   in this spec, so it's still an assumption carried over from the
//   original brief — worth a quick sanity check against a real invoice
//   link before relying on it.)
// - Auth: `Authorization: Bearer <api_key>`.
// - Pagination is cursor-based: `id_gt` / `id_lt`, not page numbers. The
//   response includes a `links.previousPage`/`links.nextPage` pair, but
//   Splose's own doc has their descriptions swapped relative to their
//   example values, so rather than trust those labels, this walks forward
//   using the highest `id` seen on each page as the next `id_gt`. Page
//   size is server-controlled (not documented), so we just loop until an
//   empty page comes back.
// - Invoice `status` enum is only `Draft` / `Awaiting Payment` / `Paid` —
//   there's no "overdue" status. We filter server-side for
//   `Awaiting Payment` and apply our own age-since-due-date threshold
//   client-side, same as originally designed.
// - No `amount_due` field: it's `total - paidAmount`.
// - No currency field on the invoice. Splose is AU-focused (NDIS/allied
//   health), so AUD is a reasonable default, but it's an inference, not
//   something the spec states — flagged here rather than presented as
//   confirmed.
// - No contact/client name on the invoice — just `patientId` and a
//   nullable `contactId` (who's actually billed, if not the patient).
//   Resolving a display name means a separate lookup against
//   `/patients` / `/contacts`; see names.js for how that's cached instead
//   of hitting those endpoints on every poll.
//
// USER-AGENT: Chrome blocks `fetch()` from setting a User-Agent header
// directly (it's a "forbidden header name" per the Fetch spec, enforced
// regardless of what you pass). background.js installs a
// declarativeNetRequest rule that rewrites the outgoing User-Agent for
// requests to api.splose.com/v1/* instead — don't try to set it here, it
// will be silently dropped.

const API_BASE = "https://api.splose.com/v1";

export class RateLimitError extends Error {}

async function apiGet(path, { apiKey }, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    throw new RateLimitError("Splose API rate limit hit (429).");
  }
  if (!res.ok) {
    throw new Error(`Splose API error ${res.status} on ${path}: ${await safeText(res)}`);
  }

  return res.json();
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}

function normalizeInvoice(raw) {
  const amountDue =
    typeof raw.total === "number" && typeof raw.paidAmount === "number"
      ? Math.max(0, raw.total - raw.paidAmount)
      : raw.total ?? null;

  return {
    id: String(raw.id),
    number: raw.invoiceNumber ?? String(raw.id),
    status: raw.status, // "Draft" | "Awaiting Payment" | "Paid"
    dueDate: raw.dueDate ? new Date(raw.dueDate).toISOString() : null,
    issuedDate: raw.issueDate ? new Date(raw.issueDate).toISOString() : null,
    total: raw.total ?? null,
    paidAmount: raw.paidAmount ?? null,
    amountDue,
    currency: "AUD", // inferred, not a field in the API — see note above
    patientId: raw.patientId != null ? String(raw.patientId) : null,
    contactId: raw.contactId != null ? String(raw.contactId) : null,
  };
}

/**
 * Fetches every "Awaiting Payment" invoice via cursor pagination.
 * Sequential (not parallel) requests by design — Splose's 60/min limit and
 * the 1s-average-latency rule both reward gentle, predictable traffic over
 * a burst of concurrent calls. Filtering server-side by status also means
 * we're only ever paginating through genuinely unpaid invoices, not the
 * whole ledger.
 */
export async function fetchAllUnpaidInvoices({ apiKey }) {
  const all = [];
  let cursor = undefined;
  let iterations = 0;
  const maxIterations = 50; // safety valve against a pagination bug looping forever

  while (iterations < maxIterations) {
    iterations += 1;
    const body = await apiGet("/invoices", { apiKey }, {
      status: "Awaiting Payment",
      id_gt: cursor,
    });

    const items = body.data ?? [];
    if (items.length === 0) break;

    for (const raw of items) all.push(normalizeInvoice(raw));

    cursor = Math.max(...items.map((i) => i.id));
  }

  return all;
}

/**
 * Fetches every page of /patients or /contacts, same cursor-pagination
 * approach. Exported so names.js can build its id -> display-name cache.
 */
export async function fetchAllPages(path, { apiKey }) {
  const all = [];
  let cursor = undefined;
  let iterations = 0;
  const maxIterations = 200;

  while (iterations < maxIterations) {
    iterations += 1;
    const body = await apiGet(path, { apiKey }, { id_gt: cursor });
    const items = body.data ?? [];
    if (items.length === 0) break;
    all.push(...items);
    cursor = Math.max(...items.map((i) => i.id));
  }

  return all;
}
