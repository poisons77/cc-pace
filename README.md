# cc-pace

Claude Code statusline that answers one question: **am I burning my usage too fast?**

```
Session: 17% (2h30m) | Weekly: 90% (2d0h) 1.26x Fri 21:20 | main [*+]
```

Read that as: the 5-hour window is 17% used with 2h30m left; the weekly window is 90% used with
2 days left, being spent **1.26x faster than the budget allows**, and at this rate it runs dry
**Friday 21:20** - well before it resets.

## Why

Claude Code shows you a percentage. A percentage alone can't tell you whether 71% is fine or
alarming - that depends entirely on how much of the window has elapsed. cc-pace divides the two.

## No API calls, ever

Since Claude Code 2.1.80 the statusline payload already contains `rate_limits`. cc-pace reads that
from stdin and does arithmetic. It makes **zero network requests**, consumes **zero tokens**, and
cannot be rate limited. Run twenty sessions side by side if you like.

## Install

```jsonc
// ~/.claude/settings.json
{
  "statusLine": { "type": "command", "command": "npx -y cc-pace" }
}
```

`cc-pace --setup` prints that snippet. For a faster cold start, install it once and drop the `npx`:

```bash
npm install -g cc-pace
```

```jsonc
{ "statusLine": { "type": "command", "command": "cc-pace" } }
```

Restart Claude Code.

## The pace ratio

```
ratio = used% / elapsed%
```

A rate-limit window starts exactly its own length before it resets, so `elapsed%` is known without
any history: a 7-day window resetting in 2 days is 71.4% elapsed. Spending 71% of the budget by
then is a ratio of `0.99` - dead on target.

| Ratio | Colour | Meaning |
| --- | --- | --- |
| `< 0.95` | green | under budget; the ETA is hidden because the window never runs dry |
| `0.95 - 1.10` | yellow | on the line |
| `> 1.10` | red | the window depletes before it resets |

The ETA is the projected moment usage reaches 100% at the current average rate.

## Segments

| Segment | Source |
| --- | --- |
| `Session` | `rate_limits.five_hour` - 5-hour rolling window |
| `Weekly` | `rate_limits.seven_day` - 7-day window, carries the pace ratio by default |
| `Opus` / `Sonnet` | `rate_limits.seven_day_opus` / `seven_day_sonnet`, when your plan reports them |
| git | branch plus `*` modified, `+` untracked, `↓n` behind, `↑n` ahead |

Buckets Claude Code starts sending that cc-pace has never heard of are rendered anyway, with a
humanised label, rather than silently dropped.

## Options

| Flag | Effect |
| --- | --- |
| `--demo` | render a bundled sample payload; no stdin needed |
| `--dump` | pretty-print the raw statusline JSON and exit |
| `--json` | print the computed metrics as JSON instead of a line |
| `--no-color` | disable ANSI colour (`NO_COLOR` is honoured too) |
| `--setup` | print the settings.json snippet |
| `--config` | print the resolved config and where it was loaded from |

`--dump` is the fastest way to see what Claude Code actually hands a statusline command.

`--json` exposes numbers the line has no room for, including `safe_rate_percent_per_day` - how much
of the budget you can spend per day from now on and still land exactly at the reset.

## Configuration

Optional. Zero-config is the supported default. `~/.config/cc-pace/config.json`:

```json
{
  "segments": ["session", "weekly", "git"],
  "separator": " | ",
  "paceOn": ["seven_day"],
  "eta": "when-early",
  "warn": 0.95,
  "danger": 1.1,
  "usedWarn": 50,
  "usedDanger": 80,
  "ascii": false
}
```

- `segments` - order and contents of the line. `"limits"` expands to every bucket present.
  Aliases: `session`, `weekly`, `opus`, `sonnet`.
- `paceOn` - which buckets get the ratio and ETA. Add `"five_hour"` to pace the session too.
- `eta` - `when-early` (default), `always`, or `never`.
- `ascii` - use `v`/`^` instead of `↓`/`↑` for fonts without the arrows.

Environment overrides: `CC_PACE_SEGMENTS`, `CC_PACE_SEPARATOR`, `CC_PACE_ETA`, `CC_PACE_ASCII`,
`CC_PACE_CONFIG`, `NO_COLOR`.

## Performance

The statusline re-renders on activity, so startup is the only cost that matters. Node's own boot
time is a floor no Node CLI beats, and it swings by tens of milliseconds across platforms, so the
number worth quoting is the **overhead cc-pace adds on top of that floor**.

The budget is **30 ms**, and CI fails the build past it. Measure it on your own machine:

```bash
npm run bench
```

One Windows laptop reports:

```
runs          20
node boot     36.5 ms  (floor, not ours)
cc-pace total 52.6 ms
our overhead  16.1 ms  (budget 30 ms)
```

Zero runtime dependencies, and git state comes from a single `git status --porcelain=v2 --branch`
rather than four separate invocations.

## Robustness

A statusline that throws is worse than one that is briefly empty. Malformed JSON, a missing
`rate_limits`, a broken config file, a directory that is not a git repository - each degrades to a
shorter line, never to a stack trace.

## Compatibility

Requires Claude Code >= 2.1.80 for `rate_limits` in the statusline payload, and Node >= 22. On
older Claude Code versions the limit segments are simply absent.

`rate_limits` is an internal payload shape and can change without notice. cc-pace treats every
field as optional for that reason.

## Development

```bash
npm test        # 53 tests, node:test, no dependencies
npm run demo
npm run bench
```

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of their respective owner.
