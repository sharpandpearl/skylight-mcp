/**
 * Round-trips the write path against a real frame: create -> read back -> update
 * -> read back -> delete -> confirm gone.
 *
 * The created event is deleted in a finally block, so a failure partway through
 * still cleans up after itself rather than leaving junk on a family calendar.
 */
import * as sky from "./client.js";

const FRAME = process.env.TEST_FRAME_ID;
if (!FRAME) throw new Error("Set TEST_FRAME_ID");

const TITLE = "DELETE ME - mcp write test";
// Far enough out that it cannot be confused with anything real.
const DAY = "2027-01-14";
const starts_at = `${DAY}T15:00:00-05:00`;
const ends_at = `${DAY}T15:30:00-05:00`;

const frames = await sky.listFrames();
const frame = frames.find((f) => String(f.id) === String(FRAME));
const tz = frame?.timezone ?? "America/New_York";
console.log(`frame ${FRAME} (${frame?.name}) tz=${tz}\n`);

// The range must straddle the day; after === before returns nothing.
const WINDOW = { after: "2027-01-13", before: "2027-01-15" };
const find = async () =>
  (await sky.listEvents(FRAME, { ...WINDOW, timezone: tz })).filter(
    (e) => e.summary === TITLE || e.summary === `${TITLE} (edited)`,
  );

let created = null;
let pass = 0;
let fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

try {
  // ---------- CREATE ----------
  console.log("1. create");
  created = await sky.createEvent(FRAME, {
    summary: TITLE,
    starts_at,
    ends_at,
    all_day: false,
    timezone: tz,
    description: "Automated write-path check. Safe to delete.",
  });
  const id = created?.id ?? created?.uid;
  console.log(`   returned id: ${id}`);
  check("create returned an id", Boolean(id));

  let found = await find();
  check("event reads back in a range query", found.length === 1, `found ${found.length}`);
  if (found.length === 1) {
    check("title round-tripped", found[0].summary === TITLE);
    check("start time round-tripped", String(found[0].starts_at).startsWith(`${DAY}T15:00`),
      found[0].starts_at);
  }

  const eventId = found[0]?.id ?? id;

  // ---------- UPDATE ----------
  console.log("\n2. update");
  await sky.updateEvent(FRAME, eventId, {
    summary: `${TITLE} (edited)`,
    location: "Nowhere",
  });
  found = await find();
  check("update persisted the new title",
    found.length === 1 && found[0].summary === `${TITLE} (edited)`,
    found[0]?.summary);
  check("update persisted location", found[0]?.location === "Nowhere", String(found[0]?.location));

  // ---------- DELETE ----------
  console.log("\n3. delete");
  await sky.deleteEvent(FRAME, eventId);
  created = null; // handled
  found = await find();
  check("event is gone after delete", found.length === 0, `still found ${found.length}`);
} catch (err) {
  console.log(`\n  ERROR: ${err.message}`);
  fail++;
} finally {
  if (created) {
    // Create succeeded but a later step threw: do not leave the event behind.
    const leftovers = await find().catch(() => []);
    for (const e of leftovers) {
      try {
        await sky.deleteEvent(FRAME, e.id);
        console.log(`  cleanup: removed leftover event ${e.id}`);
      } catch (e2) {
        console.log(`  CLEANUP FAILED for ${e.id}: ${e2.message} -- delete it by hand`);
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
