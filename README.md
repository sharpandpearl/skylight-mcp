# skylight-mcp

An MCP server for managing [Skylight Calendar](https://www.skylightframe.com/) frames —
list and search events, add, edit and delete them, and see which family profile each
event belongs to.

Built against the community API notes at
<https://gist.github.com/dknowles2/b8eab833eb23eb388c3d78999a3565f8>, with the request
and response shapes verified against the live API.

## Tools

| Tool | What it does |
|---|---|
| `skylight_list_frames` | List frames (calendars/devices) with ids and timezones |
| `skylight_list_profiles` | Family member profiles on a frame |
| `skylight_list_calendars` | Source calendars feeding a frame, and which are editable |
| `skylight_list_events` | Events between two dates, with assigned profile |
| `skylight_search_events` | Free-text search over events |
| `skylight_create_event` | Add an event (timed, all-day, or recurring via RRULE) |
| `skylight_update_event` | Change fields on an existing event |
| `skylight_delete_event` | Remove an event |

## Credentials

The server needs `SKYLIGHT_EMAIL` and `SKYLIGHT_PASSWORD`. Keep them in 1Password and
inject them at launch rather than writing them into a config file:

```jsonc
{
  "mcpServers": {
    "skylight": {
      "command": "op",
      "args": [
        "run", "--no-masking", "--",
        "node", "C:/GitHub_Repos/skylight-mcp/src/index.js"
      ],
      "env": {
        "SKYLIGHT_EMAIL": "op://<vault>/<item>/username",
        "SKYLIGHT_PASSWORD": "op://<vault>/<item>/password"
      }
    }
  }
}
```

Replace `<vault>` and `<item>` with your own. `op run` resolves the `op://` references into the child process's environment, so the
secrets never touch disk.

## How authentication works

Skylight uses OAuth 2.0 Authorization Code + PKCE, but the credential step is a
server-rendered Rails form rather than a JSON endpoint. `src/auth.js`:

1. `GET /auth/session/new` — scrape the `csrf-token` meta tag, keep the session cookie
2. `GET /oauth/authorize?...` — bind the PKCE challenge to the session
3. `POST /auth/session` — submit `authenticity_token`, `email`, `password`
4. Follow redirects **manually** until `?code=` appears (the code only exists in a
   `Location` header; automatic redirect following loses it)
5. `POST /oauth/token` — exchange code + `code_verifier` for tokens

Tokens are cached at `~/.skylight-mcp/token.json` with mode `0600` and refreshed
automatically; a failed refresh falls back to a full login. Override the location with
`SKYLIGHT_TOKEN_PATH`.

## Notes discovered against the live API

- `GET /calendar_events` **requires** `after`, `before` *and* `timezone` together.
  Any other combination returns `422 {"errors":["Invalid query range or timezone"]}`.
- Events carry their family profile as a JSON:API relationship
  (`relationships.category.data.id`), with the labels in the response's `included`
  array. `skylight_list_events` resolves this for you.
- Events sourced from a synced Google calendar report `source: "google"` and can still
  be `editable: true`.
