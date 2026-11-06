# Changelog

Every release is also on [GitHub Releases](https://github.com/poisons77/cc-pace/releases) and on npm
as [`claude-code-pace`](https://www.npmjs.com/package/claude-code-pace).

## 0.5.1 - 2026-11-06

- The README describes how rotation stops to ask, with both status lines.
- This changelog.

## 0.5.0 - 2026-11-06

Rotation no longer trusts a stale session, and stops to ask instead of guessing.

**Fixed**

- A session left idle since a switch keeps rendering the account it last spoke to. Its numbers
  were filed under the live account, which could flee an account that was not spent and save it as
  about to refill - so it later ranked as a fresh week and was switched into while nearly spent. A
  reading outside the live account's own saved window that falls in another account's saved window
  is now recognised as that account's, and decides nothing.
- A saved window's use never goes down: a lower reading of the same window is a stale payload.
- A reading whose reset has already passed is no longer saved.

**New**

- After a switch, the first reading of the new account is checked. Already over its bar, rotation
  stops instead of moving on, and the line shows `! work already at 99% · pick an account` until you
  switch by hand.
- `askIfUnreadSecs`: stop and ask instead of switching into an account last read longer ago than
  this, or never. Off by default.
- The question is published as `ask` in the state file; cc-account 0.5.0 shows it in red in every
  session.
- `rotate.log` records each stop as an `ask` line.

## 0.4.1 - 2026-11-03

- One depletion time per window: when the last hour's rate hits 100% before the reset, its time
  replaces the averaged ETA beside the ratio (`2.76x today 16:18`) instead of a second alert at the
  end of the line.
- The standalone `Week 3h13m to 100% (16:18)` appears only when that window is not on the line, and
  sits right after the limits by default.

## 0.4.0 - 2026-11-01

- Chain an existing statusline: set `chain` in the config and its output joins the line.
- Shorter line: `Pool:` merges the session's share and the pool outlook, `Cache:` merges context %
  and the cold-cache warning; `Week`, `med+`, and the hours without quota as `-34h`.
- Pool forecast: the rate eases from the week's average onto the tracked hours instead of jumping,
  and the hour tracking starts in now counts.

## 0.3.0 - 2026-11-01

- With accounts in rotation, `Pool` is one instruction: green `↑40%` to push, red
  `↓22% stop Fri 17:45 +37h` to ease off, with when every account runs dry and for how long.
- The forecast measures what the pool burns per hour of work and learns which hours of the day you
  work from Claude Code's prompt history (timestamps only).
- `Pool: 35% ...` opens with this session's share of the last hour's spend; `Cache: 42% cold in
  12m (270k)` joins how full the conversation is with the cold-cache warning. The segment names
  `share` and `memory` keep working.
- A heavy start to the week shows its ratio at once: it appears once 5% of the window has elapsed
  or 5% has been used.
- Published from a version tag through npm trusted publishing, with provenance.

## 0.2.0 - 2026-11-01

- Recent burn warning: `Weekly 1h7m to 100% (22:13)`, from the last hour, shown only when it hits
  100% before the reset.
- Over budget, the model, its settings and each model's share of the spend follow the ratio.
- Cache warning: `cache cold in 12m (270k)`.
- Memory: how full this conversation is.
- This chat: this session's share of what all open sessions spent in the last hour.
- `! config` when the config file cannot be read.
- Account rotation with cc-account: skips logins about to stop refreshing, drains the account whose
  weekly reset would waste the most quota first, and forecasts whether the accounts together last.
- `--setup` adds `refreshInterval: 60`, so the line keeps time while you are idle.
- Windows limited to one model are hidden unless `showModelWindows` is on.
- The pace ratio appears once 5% of a window has elapsed.
- `git status` runs with `--no-optional-locks`, so it never takes `index.lock` from Claude Code.

## 0.1.1 - 2026-07-26

- `--demo` works from the installed package: its payload ships in `src/`.

## 0.1.0 - 2026-07-26

- First release: usage limits, burn pace and projected depletion per window, and git state, in one
  line read from the statusline payload. No network, no dependencies.
