/**
 * Thin Skylight API client.
 *
 * Field names and query parameters here were verified against the live API,
 * not taken from documentation — notably `calendar_events` requires
 * `after`, `before` AND `timezone` together, or it returns
 * 422 {"errors":["Invalid query range or timezone"]}.
 */
import { getAccessToken, API_BASE, API_HEADERS } from "./auth.js";

async function call(path, { method = "GET", body, query } = {}) {
  const token = await getAccessToken();
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...API_HEADERS,
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const detail = parsed?.errors ? JSON.stringify(parsed.errors) : String(parsed ?? "").slice(0, 300);
    throw new Error(`Skylight ${method} ${path} -> HTTP ${res.status}: ${detail}`);
  }
  return parsed;
}

const flatten = (node) => (node?.attributes ? { id: node.id, ...node.attributes } : node);

export async function listFrames() {
  const r = await call("/frames");
  return (r.data ?? []).map((f) => ({
    id: f.id,
    name: f.attributes?.name,
    timezone: f.attributes?.timezone,
  }));
}

export async function getFrame(frameId) {
  const r = await call(`/frames/${frameId}`);
  return flatten(r.data);
}

/** Family profiles. Each event may be assigned to exactly one of these. */
export async function listProfiles(frameId) {
  const r = await call(`/frames/${frameId}/categories`);
  return (r.data ?? []).map((c) => ({
    id: c.id,
    label: c.attributes?.label,
    color: c.attributes?.color,
  }));
}

export async function listSourceCalendars(frameId) {
  const r = await call(`/frames/${frameId}/source_calendars`);
  return (r.data ?? []).map((c) => ({
    id: c.id,
    label: c.attributes?.label,
    kind: c.attributes?.kind,
    editable: c.attributes?.editable,
    default_for_new_events: c.attributes?.default_for_new_events,
  }));
}

/**
 * Events in a date range. `after`/`before` are inclusive calendar dates
 * (YYYY-MM-DD) interpreted in `timezone`.
 */
export async function listEvents(frameId, { after, before, timezone }) {
  const r = await call(`/frames/${frameId}/calendar_events`, {
    query: { after, before, timezone },
  });
  // Resolve the category relationship into a readable owner label.
  const cats = new Map(
    (r.included ?? [])
      .filter((i) => i.type === "category")
      .map((i) => [i.id, i.attributes?.label]),
  );
  return (r.data ?? []).map((e) => {
    const a = e.attributes ?? {};
    const catId = e.relationships?.category?.data?.id ?? null;
    return {
      id: e.id,
      summary: a.summary,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      all_day: a.all_day,
      timezone: a.timezone,
      location: a.location || null,
      description: a.description || null,
      recurring: a.recurring,
      rrule: a.rrule,
      source: a.source,
      editable: a.editable,
      emoji_icon: a.emoji_icon,
      profile: catId ? { id: catId, label: cats.get(catId) ?? null } : null,
    };
  });
}

export async function searchEvents(frameId, { query, timezone }) {
  const r = await call(`/frames/${frameId}/calendar_events/search`, {
    query: { query, q: query, timezone },
  });
  return (r.data ?? []).map((e) => ({ id: e.id, ...(e.attributes ?? {}) }));
}

/**
 * Create an event. `starts_at` / `ends_at` are ISO-8601 with offset
 * (e.g. 2026-10-20T13:30:00-04:00). For an all-day event pass `all_day: true`
 * with plain dates.
 *
 * Fields go at the TOP LEVEL of the body. A Rails-style
 * `{calendar_event: {...}}` wrapper is rejected with
 * 422 {"starts_at":["can't be blank"],"summary":["can't be blank"]}.
 */
export async function createEvent(frameId, event) {
  const r = await call(`/frames/${frameId}/calendar_events`, {
    method: "POST",
    body: event,
  });
  return flatten(r.data ?? r);
}

export async function updateEvent(frameId, eventId, patch) {
  const r = await call(`/frames/${frameId}/calendar_events/${eventId}`, {
    method: "PUT",
    body: patch,
  });
  return flatten(r.data ?? r);
}

export async function deleteEvent(frameId, eventId) {
  await call(`/frames/${frameId}/calendar_events/${eventId}`, { method: "DELETE" });
  return { deleted: eventId };
}
