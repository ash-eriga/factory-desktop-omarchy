# Factory Usage Service (Omarchy plugin)

An independent, tiny Omarchy shell service plugin that keeps the Factory
usage record fresh for the agents panel, with honest local accounting. It
runs this plugin's own collector
(`bin/factory-usage` → `runtime/collector.py` + `runtime/auth-helper.mjs`
+ `runtime/local_usage.py`) against the installed vendor bundle
(`/opt/factory-desktop-arch`, overridable with `FACTORY_DESKTOP_BUNDLE`)
on a timer, so a JSON record lands in
`~/.local/state/omarchy/agents/usage/factory.json`, where the panel looks
for records.

The stock and user-customized agents panels are not replaced: this plugin
only publishes a record. A panel that renders the record is a separate,
user-local component and is not part of this repository.

This repository ships no copy of the Factory mark. The package contains the
generated icons (`assets/factory.svg`, `assets/factory-light.svg`), which
the build renders from the checksum-pinned official payload; a tree copied
from the repository itself has no icon files, and the service does not read
any.

## What the record shows

- **Plan**: `tierLabel` (e.g. "Max"); a healthy account stays quiet — no
  status text, so no blank warning box.
- **Limits**: STANDARD and DROID CORE groups, each with explicit
  "5-hour" / "Weekly" / "Monthly" titles; inactive windows report 0% and
  no reset time.
- **Balance**: prepaid extra-usage balance in USD (actual, not estimated).
- **Local accounting**: tokens by day (observed deltas since the ledger's
  first run), observed growth per model (kept in a persistent accumulator
  that does not expire with the 90-day day-chart window; a session that
  switched models lands in an explicit "mixed" bucket and usage from
  before the first run stays "unattributed"), local session totals, and
  Factory Standard Credits from local sessions (`factoryCredits` per model).
  Desktop-port and CLI sessions are deduplicated by session id; only each
  session's own `tokenUsage` counts (inclusive/child totals are ignored, so
  child overlap cannot double count). The observed growth follows the
  vendor's rounded total formula, so the ledger, the day bucket and the
  device total agree; the baseline of that growth is the per-counter
  high-water envelope, so a counter that grows while another one rolls
  back still contributes its growth on the day it was observed. The record
  also carries the local day its counters belong to (`statsDate`), so a
  record written on another day cannot be presented as today's numbers.
  The rows of the day chart are calendar days (a civil day is not always
  86400 seconds long, so the rows are walked from today's local date and
  never repeat or skip a date around the daylight-saving change), and the
  ledger keeps the per-counter envelope only — the second representation
  of the same total that no reader used any more is not written and is
  discarded from the ledgers that still carry it.
- **Account inventory**: the latest ≤20 account sessions owned by the
  user, with summed session credits, explicitly marked incomplete.
  Account-global day/model history is not available from Factory's APIs
  for personal plans (usage-events, personal analytics, and session-usage
  return 403) and is not fabricated.

Credentials stay inside the helper process; records carry counters and
model ids only — no session ids, titles, cwd, organization ids, or emails.

## Install (manual, opt-in)

1. Install the `factory-desktop-arch` package (vendor bundle at
   `/opt/factory-desktop-arch`).
2. Copy this directory into the user plugin folder:

   ```bash
   cp -r factory-usage-service ~/.config/omarchy/plugins/factory.usage-service
   ```

   `cp -r` keeps the file modes, and the package ships
   `bin/factory-usage` as 0755: the service executes that runner directly
   (`Service.qml`), so it must stay executable in the copied tree.

3. Enable the service (run this yourself; nothing enables it for you):

   ```bash
   omarchy plugin enable factory.usage-service
   ```

   The enable command works after the shell discovers the plugin (the
   registry rescans `~/.config/omarchy/plugins` automatically). If you
   prefer editing `~/.config/omarchy/shell.json` directly, the `plugins`
   array takes **objects**, not strings:

   ```bash
   jq '.plugins = ((.plugins // []) + [{"id": "factory.usage-service"}])' \
     ~/.config/omarchy/shell.json | sponge ~/.config/omarchy/shell.json
   ```

   A plain `"factory.usage-service"` string entry does **not** enable the
   service: the registry reads `.plugins[j].id`.

4. Verify it is running:

   ```bash
   cat ~/.local/state/omarchy/agents/usage/factory.json
   ```

## Force refresh integration (user wrapper)

A panel that offers a manual refresh can refresh Factory too: point the
refresh wrapper at this plugin's own runner, so the panel's refresh runs
`bin/factory-usage --write` instead of the stock collector.
The collector's non-blocking lock means a manual refresh that collides
with the service timer is a no-op that preserves the last record.

## Uninstall / disable

```bash
omarchy plugin disable factory.usage-service
```

or remove the `{"id": "factory.usage-service"}` entry from the `plugins`
array in `~/.config/omarchy/shell.json`. A disabled service stops running
entirely; the last written record can be removed with:

```bash
rm ~/.local/state/omarchy/agents/usage/factory.json
```

## Limitations

- The stock panel discovers a new record at its next refresh cycle; the
  record refreshes on this service's timer (every 15 minutes) or whenever
  `factory-usage --write` / the wrapper collector runs.
- The service runs only while enabled in `shell.json`.
- The day chart is an observed-delta ledger: days before its first run
  stay empty; offline gaps land on the day the delta was observed.
- The per-model amounts are kept outside the day buckets, so the 90-day
  day-chart retention does not erase them. A ledger written before that
  accumulator existed keeps only what its day buckets still held: growth
  already discarded by the old retention is not recoverable and is never
  invented.
- `runtime/` here must be kept in sync with the repo's `runtime/` (the
  files are copies; `bin/factory-usage` points at them explicitly).
