# Account rotation

Optional. cc-pace watches the rate-limit windows it already renders and runs a command when one
crosses a threshold - it never learns what that command does. Pairing it with
[cc-account](https://github.com/poisons77/cc-account) gives automatic account switching.

Two patterns, depending on how the accounts relate.

**Peers.** Accounts of equal worth. Spend whichever one you are on down to its bar, then move to
whichever peer has the most room left. No account is privileged and there is nothing to come back
to.

**Primary and reserve.** A smaller plan whose 5-hour window fills fast, held next to a larger one
kept back. Burn the primary, move to the fallback when a window runs dry, return the moment it
refills.

## Configure

`~/.config/cc-pace/config.json` (or `$CC_PACE_CONFIG`):

```json
{
  "rotation": {
    "accounts": ["work", "personal"],
    "buckets": {
      "five_hour": 95,
      "seven_day": { "at": 95, "lateAt": 99, "lateWithinSecs": 129600 }
    },
    "command": "cc-account"
  }
}
```

| Field | Meaning |
|---|---|
| `accounts` | peers to rotate between, in no particular order |
| `buckets` | windows to watch, each with the percentage that forces a move |
| `perAccount` | bars for one account, overriding `buckets` window by window (see below) |
| `command` | prefix invoked as `<command> use <account>` (default `cc-account`) |
| `store` | where the account tool publishes identity (default `~/.claude-accounts`) |
| `log` | where decisions are appended (default `rotate.log` beside the state file; `false` disables) |
| `ascii` | plain-text status marks instead of arrows |
| `enabled` | `false` switches the engine off and keeps every other key, so switching it back on restores the setup |
| `switchAheadSecs` | also switch when the recent burn rate hits 100% within this many seconds (default off) |
| `askIfUnreadSecs` | peers only: stop and ask instead of switching into an account last read longer ago than this, or never (default off) |

For the primary-and-reserve shape, name `primary` and `fallback` instead of `accounts`, and add
`returnGraceSeconds` to wait past the reset before returning (default 60). Both shapes read the
same `buckets`.

`buckets` also accepts an array (`["five_hour"]`, all at `at`) or the singular `bucket` with `at`.

**Use different thresholds per window.** A 5-hour window refills the same day, so leaving a few
percent unused costs nothing. A weekly window is the scarce resource on a large plan - every
percent abandoned there is gone for days, which is why 99 suits it and 95 suits the short one.

**Raise the bar as the reset nears.** A bucket may take `{ "at": 95, "lateAt": 99,
"lateWithinSecs": 129600 }` instead of a plain number. Percent left behind early in a window is
percent unavailable for days, so the move happens at `at`; inside `lateWithinSecs` of the reset the
refill is close and the same percent is nearly worthless, so `lateAt` drains the account rather
than fleeing it.

**Give one account its own bars.** `perAccount` maps an account name to windows in the `buckets`
shapes, and each field set there wins over the shared one; every field left out, and every account
left out, follows `buckets`. `"lateAt": false` removes the late bar for that account alone. The
account is left at its own bars and ranked by the room under them.

```json
"perAccount": {
  "work": { "seven_day": 80 },
  "personal": { "seven_day": { "lateAt": false } }
}
```

Here `work` leaves its week at 80% and still drains to the shared `lateAt` near the reset;
`personal` leaves at the shared `at` all week. Overrides apply only to windows `buckets` watches.

## Behaviour

Peers:

```
any watched window at/above its bar        ->  switch to the peer with the most room left
no peer with room                          ->  stay, and say so
landed on a peer already at/above its bar  ->  stop, and ask
the chosen peer read too long ago          ->  stop, and ask   (with askIfUnreadSecs)
```

A peer is chosen on what was saved of it, often days old. Its first reading as the live account is
the check: already over a bar, rotation stops rather than moving on by itself, and stays stopped
while that account is live and over its bar. Switching account by hand - `cc-account use` or
`cc-account rotate` - answers it. The question is published as `ask` in the state file:

```
{ reason: "spent", on, name, used, at }      landed on `name`, already at `used`%
{ reason: "unread", on, name, readAt, at }   would have moved from `on` to `name`, last read at `readAt`
```

cc-account shows it in red above the prompt of every session.

Primary and reserve:

```
on primary,  any watched window at/above its bar        ->  switch to fallback
on fallback, the clock passes the stored reset + grace  ->  switch back to primary
```

Among peers with room, the target is the one whose weekly reset would waste the most quota
(elapsed% minus used%), then the one with the most room. Quota left at a reset is lost, so an
account at 60% whose week ends in two hours is drained before one at 40% with six days left. With
only 5-hour windows watched, room alone decides.

An account whose saved login stops refreshing within the hour is skipped - the same hour
cc-account shows in red.

The engine publishes that order as `ranking` in its state file, every account best first with
`eligible`, `reason` (`login` or `spent`), `room`, `spare` and `freeAt` - when a spent account gets
room again, the latest reset among the windows holding it. cc-account's `rotate` reads it.

**Forecast.** Beside the ranking the engine publishes `forecast`: whether the accounts in rotation,
together, last at the current burn.

```
{ at, window, burn, sustainable, rate, allowed, workHours,
  accounts: [{ name, used, resets }], unknown, runsOutAt, resumesAt }
```

`window` is `seven_day` when watched, else `five_hour`. `burn` is the live ratio of the active
account; `sustainable` is how many accounts can be drawn on, since each refills once per window. A
login about to stop refreshing is left out.

The forecast is played over the hours this person works (`src/pool.js`):

- `rate` - what the pool burns per hour of work, in percent of one account. The state file keeps a
  `ledger` of what the active account spent in each hour for two weeks; a switch or a rolled window
  starts a new baseline rather than counting as spend. Worked hours are weighted newest first with
  a three-hour half-life. The active account's use this window over the hours worked in it is the
  starting point; the ledger takes over in proportion to the hours of work it has seen, wholly from
  three, so a fresh ledger moves the rate gradually rather than in one render. The hour the ledger
  started in counts for the part of it the ledger saw.
- `workHours` - hours worked per day, from a profile of the share of the last 14 days each hour of
  the day was worked. Worked means a prompt in Claude Code's `history.jsonl` (read incrementally,
  timestamps only, kept as `activity`) or the pool burning.
- `allowed` - the highest `rate` the pool sustains for one window from now.

The simulation burns `rate` scaled by the profile, hour by hour, draws on the account whose reset
comes first, refills each at its reset, and counts an account never observed as full. `runsOutAt`
is when all are empty with a reset still ahead (to the quarter hour), `resumesAt` that next reset;
both are null when the quota lasts the window. Without any worked hour yet, `rate`, `allowed` and
`workHours` are null and the stop is played from `burn` held around the clock. The status line's
`pool` segment shows green `↑40%` or red `↓24% stop Sat 05:10 -26h` (`-26h` is `resumesAt` less
`runsOutAt`), and the older
`2.10x/2.0x stop Sat 05:10` while `rate` is null.

**Switching before the wall.** A switch fires only when the status line renders, and a long
subagent run can burn the last few percent between two renders. `switchAheadSecs` makes a window
count as spent once its recent burn rate reaches 100% within that many seconds; the log marks such
readings `~burn`.

In primary-and-reserve mode, the fallback's own usage never triggers a switch: there is nowhere better to go, so moving
would only bounce back. When several windows are over at once, the stored block runs until the
**latest** of their resets - a weekly cap holds the return for days rather than returning within
the hour and bouncing straight back out.

## What is known about the account you are not on

The payload describes the active account only, so every other account is judged by what was read of
it while it *was* active. Those readings are kept per account and carried across switches.

This is stale on utilization and exact on the reset. An account climbs while it is not live only
through use the status line never sees - claude.ai, the desktop app, another machine - and
`askIfUnreadSecs` puts a person in front of any switch into a reading older than that. A reset that
has passed is the strongest answer available: the window has refilled, whatever it last read. An
account never observed counts as usable, since assuming the worst of an unknown would strand you on
a spent one.

Use within a window only climbs, so a reading lower than the one saved for the same window is a
stale payload and the saved one stands. A reading whose reset has passed is not filed.

Readings are **not** filed during the settle window below: they still describe the account just
left, and filing them under the new one would corrupt the very ledger that picks the next target.

Nor are they filed from a session idle since the switch. Each session's payload comes from its own
last API response, so an idle session keeps rendering the account it last spoke to, for days. A
reading outside the live account's own saved window that falls in another account's saved window is
that account's, and the render decides nothing. On an account rotation has just landed on, any
reading in another account's saved window waits for the next one.

## When a switch does not happen

The switch is spawned detached with its output discarded, so the account tool publishing the new
identity is the only evidence it worked. If the target has not become active once the cooldown
passes, the move is recorded as failed rather than done - no receipt is shown, the bar says
`! switch to <account> failed`, and the target is left alone for five minutes so a broken command
costs a log line rather than one spawn per keystroke.

## Reading what happened

Every decision that changed something appends one line beside the state file:

```
2026-09-01T07:03:01Z fire action=to-peer from=personal target=work because=seven_day read=seven_day:99%
2026-09-01T07:03:47Z land target=work active=work after=46s
2026-09-01T07:06:02Z ask reason=spent on=work target=work read=seven_day:99%
```

Transitions only - never one per render - so it stays small without pruning. `fire` records what
the payload said and which window forced the move, so a decision can be judged afterwards instead
of inferred from file timestamps.

## Status line

```
Session: 95% (2h18m) | Week: 67% (4d20h) | → switching to personal
Session: 4% (58m)    | Week: 99% (6d18h) | ! all limited · work in 4d20h
Session: 2% (5h0m)   | Week: 61% (4d2h)  | ✓ on personal
Session: 4% (58m)    | Week: 99% (6d18h) | ! switch to work failed
Session: 3% (4h40m)  | Week: 99% (1d20h) | ! work already at 99% · pick an account
Session: 40% (2h10m) | Week: 95% (3d2h)  | ! work last read 3d4h ago · switch?
```

With `primary` and `fallback`, two more appear: `↩ work in 2h19m` while waiting out the primary's
window, and `! both limited · work in 4d20h` when the reserve is capped too.

A receipt is shown only while it is still true. Switch by hand inside the two minutes it lingers
and it disappears, rather than naming an account you have already left.

The state file is global, so **every session displays the rotation**, not only the one that crossed
the threshold - the switch itself is machine-wide. Each session picks it up on its next render, so
an idle session lags until touched.

## What it costs a render

Nothing measurable. The status line is written first; the engine then runs, and any switch is
spawned detached and never awaited. The rendered text is stored as a finished string, so displaying
it is a single field read.

## Requirements and limits

The account tool must publish which account is live, because **the statusline payload contains no
account identity** - no email, organisation, or plan. cc-account writes
`~/.claude-accounts/rotation-state.json` on every switch and on `cc-account current`.

Rotation only runs **when the status line renders**. A threshold crossed during a long subagent run
is missed until the next main-loop turn. Peer rotation has no clock-only trigger at all, so every
decision it makes depends on a render.

**Nothing is decided for two minutes after a switch.** `rate_limits` arrives with the last API
response, so immediately after a move it still describes the previous account. Acting on it inverts
the decision - a manual move off a spent account reads as the account just arrived at being spent,
and the switch is undone, handing the next render the same stale evidence. The engine waits for
`switchedAt` in the account tool's state file to age past the settle window before judging anything.

Utilization of an account you are not on is only ever as fresh as the last time you were on it. The
reset is exact; the percentage is a floor.
