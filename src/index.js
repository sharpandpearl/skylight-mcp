#!/usr/bin/env node
/**
 * Skylight Calendar MCP server (stdio).
 *
 * Credentials: set SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD, ideally through
 * 1Password's `op run` so the secrets never land in a config file.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as sky from "./client.js";

const server = new McpServer({ name: "skylight", version: "0.1.0" });

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const FrameId = z.string().describe("Frame id, from skylight_list_frames");

server.registerTool(
  "skylight_list_frames",
  {
    title: "List Skylight frames",
    description:
      "List the Skylight frames (calendars/devices) on this account, with their ids and timezones. " +
      "Every other tool needs a frame id, so start here.",
    inputSchema: {},
  },
  wrap(() => sky.listFrames()),
);

server.registerTool(
  "skylight_list_profiles",
  {
    title: "List family profiles",
    description:
      "List the family member profiles (Skylight calls them categories) on a frame. " +
      "An event can be assigned to one profile, which controls its colour on the display.",
    inputSchema: { frame_id: FrameId },
  },
  wrap(({ frame_id }) => sky.listProfiles(frame_id)),
);

server.registerTool(
  "skylight_list_calendars",
  {
    title: "List source calendars",
    description:
      "List the calendars feeding a frame (Google, Apple, WebCal, or Skylight's own), " +
      "showing which are editable and which receives new events by default.",
    inputSchema: { frame_id: FrameId },
  },
  wrap(({ frame_id }) => sky.listSourceCalendars(frame_id)),
);

server.registerTool(
  "skylight_list_events",
  {
    title: "List calendar events",
    description:
      "List events on a frame between two dates (inclusive). Returns each event's id, title, " +
      "start/end, location, recurrence and assigned family profile. " +
      "The date range is required — the API rejects an unbounded query.",
    inputSchema: {
      frame_id: FrameId,
      after: z.string().describe("Start of range, YYYY-MM-DD (inclusive)"),
      before: z
        .string()
        .describe("End of range, YYYY-MM-DD (inclusive). May equal `after` for a single day."),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, e.g. America/New_York. Defaults to the frame's own timezone."),
    },
  },
  wrap(async ({ frame_id, after, before, timezone }) => {
    // The API requires a timezone; fall back to whatever the frame is set to.
    let tz = timezone;
    if (!tz) {
      const frames = await sky.listFrames();
      tz = frames.find((f) => String(f.id) === String(frame_id))?.timezone ?? "America/New_York";
    }
    // A zero-width range (after === before) returns nothing, so widen a
    // same-day query by a day on each side and trim back to the asked-for date.
    if (after === before) {
      const d = new Date(`${after}T12:00:00Z`);
      const shift = (n) => new Date(d.getTime() + n * 864e5).toISOString().slice(0, 10);
      const wide = await sky.listEvents(frame_id, {
        after: shift(-1), before: shift(1), timezone: tz,
      });
      return wide.filter((e) => String(e.starts_at).slice(0, 10) === after);
    }
    return sky.listEvents(frame_id, { after, before, timezone: tz });
  }),
);

server.registerTool(
  "skylight_search_events",
  {
    title: "Search calendar events",
    description: "Free-text search across a frame's calendar events.",
    inputSchema: {
      frame_id: FrameId,
      query: z.string().describe("Text to search for"),
      timezone: z.string().optional().describe("IANA timezone; defaults to the frame's"),
    },
  },
  wrap(async ({ frame_id, query, timezone }) => {
    let tz = timezone;
    if (!tz) {
      const frames = await sky.listFrames();
      tz = frames.find((f) => String(f.id) === String(frame_id))?.timezone ?? "America/New_York";
    }
    return sky.searchEvents(frame_id, { query, timezone: tz });
  }),
);

server.registerTool(
  "skylight_create_event",
  {
    title: "Create a calendar event",
    description:
      "Add an event to a Skylight frame. For a timed event give ISO-8601 times with an offset " +
      "(2026-10-20T13:30:00-04:00). For an all-day event set all_day true and pass plain dates. " +
      "This writes to a shared family calendar everyone in the household can see.",
    inputSchema: {
      frame_id: FrameId,
      summary: z.string().describe("Event title"),
      starts_at: z.string().describe("ISO-8601 start, or YYYY-MM-DD when all_day"),
      ends_at: z.string().describe("ISO-8601 end, or YYYY-MM-DD when all_day"),
      all_day: z.boolean().optional().describe("True for an all-day event"),
      timezone: z.string().optional().describe("IANA timezone; defaults to the frame's"),
      description: z.string().optional(),
      location: z.string().optional(),
      category_id: z
        .string()
        .optional()
        .describe("Family profile id to assign the event to, from skylight_list_profiles"),
      emoji_icon: z.string().optional().describe("A single emoji shown on the frame"),
      rrule: z
        .string()
        .optional()
        .describe("iCal RRULE for a repeating event, e.g. FREQ=WEEKLY;BYDAY=MO"),
    },
  },
  wrap(async ({ frame_id, timezone, category_id, ...rest }) => {
    let tz = timezone;
    if (!tz) {
      const frames = await sky.listFrames();
      tz = frames.find((f) => String(f.id) === String(frame_id))?.timezone ?? "America/New_York";
    }
    const payload = { ...rest, timezone: tz };
    if (category_id) payload.category_id = category_id;
    return sky.createEvent(frame_id, payload);
  }),
);

server.registerTool(
  "skylight_update_event",
  {
    title: "Update a calendar event",
    description:
      "Change fields on an existing event. Only the fields you pass are modified. " +
      "Use skylight_list_events first to get the event id.",
    inputSchema: {
      frame_id: FrameId,
      event_id: z.string().describe("Event id from skylight_list_events"),
      summary: z.string().optional(),
      starts_at: z.string().optional(),
      ends_at: z.string().optional(),
      all_day: z.boolean().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      category_id: z.string().optional(),
      emoji_icon: z.string().optional(),
    },
  },
  wrap(({ frame_id, event_id, ...patch }) => {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(clean).length) throw new Error("No fields given to update");
    return sky.updateEvent(frame_id, event_id, clean);
  }),
);

server.registerTool(
  "skylight_delete_event",
  {
    title: "Delete a calendar event",
    description:
      "Permanently remove an event from a Skylight frame. This affects a shared family " +
      "calendar, so confirm the event id with skylight_list_events before calling it.",
    inputSchema: {
      frame_id: FrameId,
      event_id: z.string().describe("Event id from skylight_list_events"),
    },
  },
  wrap(({ frame_id, event_id }) => sky.deleteEvent(frame_id, event_id)),
);

await server.connect(new StdioServerTransport());
