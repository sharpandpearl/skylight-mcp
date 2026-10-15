/**
 * Discovery script. Authenticates, then reports the SHAPE of the live responses
 * (field names and value types) so the MCP tools can be written against what the
 * API actually returns rather than a guess. Prints no credentials and no tokens.
 */
import { getAccessToken, API_BASE, API_HEADERS } from "./auth.js";

const token = await getAccessToken();
console.log("auth: OK (token acquired)\n");

const api = async (p) => {
  const res = await fetch(`${API_BASE}${p}`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
};

/** Field name -> type, recursing one level, so we learn the schema without dumping data. */
function shape(obj, depth = 0) {
  if (obj === null) return "null";
  if (Array.isArray(obj)) return obj.length ? [shape(obj[0], depth)] : [];
  if (typeof obj !== "object") return typeof obj;
  if (depth > 2) return "{...}";
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, shape(v, depth + 1)]));
}

const user = await api("/user");
console.log("GET /user ->", user.status);
console.log(JSON.stringify(shape(user.body), null, 1), "\n");

const frames = await api("/frames");
console.log("GET /frames ->", frames.status);
const list = frames.body?.data ?? frames.body;
if (Array.isArray(list)) {
  console.log(`frames found: ${list.length}`);
  for (const f of list) {
    const a = f.attributes ?? f;
    console.log(`  id=${f.id ?? a.id}  name=${JSON.stringify(a.name ?? a.label)}  type=${a.frame_type ?? "?"}`);
  }
  console.log("\nframe object shape:");
  console.log(JSON.stringify(shape(list[0]), null, 1), "\n");

  const frameId = list[0].id ?? list[0].attributes?.id;

  for (const path of [
    `/frames/${frameId}/categories`,
    `/frames/${frameId}/calendar_events`,
    `/frames/${frameId}/source_calendars`,
  ]) {
    const r = await api(path);
    console.log(`GET ${path} -> ${r.status}`);
    const d = r.body?.data ?? r.body;
    if (Array.isArray(d)) {
      console.log(`  count: ${d.length}`);
      if (d.length) console.log("  item shape:", JSON.stringify(shape(d[0]), null, 1));
    } else {
      console.log("  shape:", JSON.stringify(shape(d), null, 1));
    }
    console.log();
  }
} else {
  console.log("unexpected /frames body:", JSON.stringify(shape(frames.body), null, 1));
}
