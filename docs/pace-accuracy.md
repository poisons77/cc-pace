# Reading the pace numbers

The pace ratio is `used% ÷ elapsed%`: 1.00x means spending exactly on budget for the window,
above 1 means the window runs dry before it resets.

That single number fails at both ends of a window, in opposite directions, and the recent-rate
warning that covers the late failure has a third failure of its own. All three are handled, and
knowing which is which explains what the status line shows.

## Early: the denominator is near zero

Minutes into a 7-day window, `elapsed%` is a fraction of a percent. Real reading:

```
Weekly: 1% (6d23h) 46.88x Tue 20:35
```

Three minutes in, 1.4% used:

```
elapsed% = 180 / 604800 = 0.03%
ratio    = 1.4 / 0.03   = 47x
```

The 47 is almost entirely the small denominator, and the ETA extrapolated three minutes across a
week - predicting a 7-day budget would be gone that same evening.

**Below `minElapsedPct` (default 2) the ratio and ETA are hidden**; `used%` and time remaining
still show. Two percent is 3.4 hours into a week, 6 minutes into a 5-hour window. Below it a small
absolute error in `used%` swamps the ratio; above it the number settles.

`--json` reports `pace_reliable` so downstream consumers can tell suppression from absence.

## Late: the average hides a recent burst

The ratio is cumulative over the whole window, so it cannot see a quiet week followed by a hard
hour. Real reading:

```
Weekly: 80% (4d9h) 2.16x Wed 12:37 | Weekly 1h7m to 100% (22:13)
```

| | Says |
|---|---|
| `2.16x Wed 12:37` | averaged over the window, exhausted Wednesday midday |
| `Weekly 1h7m to 100% (22:13)` | at the last hour's rate, exhausted tonight |

Cumulative burn there was ~1.27%/hour; the recent rate was ~18%/hour - **14× higher**. The average
is not wrong, it answers a different question: *am I on budget for the week*, rather than *when do
I hit the wall doing what I am doing now*.

`src/burn.js` keeps a short trailing history of `{time, used%}` per window in
`~/.config/cc-pace/burn-history.json` and derives the slope over the last hour.

It stays silent unless the recent rate would exhaust the window **before** it resets - a wall past
the reset is not a wall.

| Case | Behaviour |
|---|---|
| Window rolls over (new `resets_at`) | history discarded; never averages across windows |
| `used%` drops within the same window | the reading is discarded, the history kept - see staleness below |
| Under 2 samples, or spanning under 5 minutes | no rate - quantised `used%` would dominate the slope |
| Flat history | no rate |
| Already at 100% | silent |
| Repeated identical readings | collapsed, so idle renders do not dilute the slope |
| Wall further out than `MAX_EXTRAPOLATION` × the measured span | silent - see below |

### How far a slope may be projected

Half an hour of samples describes half an hour of behaviour. Real reading, 28% used on a weekly
window with 5 days left:

```
Weekly: 28% (5d5h) 1.11x | 16h46m to 100%
```

The 4.29%/hour was measured correctly - two agents running hard do burn that fast. The projection
then carried it across seventeen unbroken hours, which assumes the work continues all night. That
is a **36× extrapolation** from the evidence, and it reads as "you are about to lose your quota" to
someone who has used barely a quarter of it.

`MAX_EXTRAPOLATION = 6` bounds the claim to six times the stretch the slope was measured over. Half
an hour of samples supports a wall up to three hours out; a wall eighteen hours out needs about
three hours of sustained evidence. `projectWall` returns `measuredOverSecs` so the basis is
inspectable.

This matters most on the weekly window, where the reset is days away and almost any burst projects
a wall before it. On the 5-hour window the reset arrives first anyway, so the cap rarely binds.

## The third failure: samples of different vintages

`rate_limits` does not describe the machine. It arrives in the status line payload from **that
session's own most recent API response**, so with many sessions open, each one carries a different
vintage of the same numbers. An idle session reports figures that were true an hour ago, stamped
with the moment they were recorded.

Observed live, from `burn-history.json` with 16 sessions running:

```
seven_day:  8% @ t        r=1787043600
           26% @ t+67s    r=1787043600
           27% @ t+1060s  r=1787043600
```

Eighteen weekly points in 67 seconds is impossible. The `8%` came from a session that had been
quiet; the `26%` was the truth. Read whole, that series projects **64%/hour** and a wall an hour
out. The real slope is the last leg: **3.6%/hour**.

A stale reading is always *lower* than the truth, because usage only climbs inside a window. It
therefore shows up twice, in two different disguises:

- as the **spike after it** - the next fresh reading looks like an impossible jump;
- as a **drop** when the stale sample arrives last, which is indistinguishable from a rollover
  unless `resets_at` is checked.

The second was the more damaging. Treating any drop as a new window meant every render from an idle
session wiped the history, so it rarely held two usable samples and the warning appeared and
vanished at random. A lower reading in the *same* window is now discarded and the history kept;
only a changed `resets_at` starts a fresh series.

Three guards, because no one of them is enough:

| Guard | Where | Catches |
|---|---|---|
| Write-time, low | `record()` | a stale reading arriving now - discarded, history preserved |
| Write-time, jump | `record()` | a stale sample already at the tail - the series restarts from the newer reading |
| Read-time | `trimImplausible()`, applied in `record()` and `recentSlope()` | history already on disk, written before the guards existed or by an older version |

The read-time pass is what makes a contaminated file **heal itself** on the next render rather than
misprojecting until the bad sample ages out six hours later. Without it, the write-time guard is
blind to its own backlog: a jump only becomes visible once the sample *after* it arrives.

The threshold is `IMPLAUSIBLE_PCT_PER_SEC = 100 / (30 * 60)` - a rate that would drain an entire
window in half an hour. Genuinely fast burns stay well under it; 12%/hour tracks normally.

### The same staleness reaches rotation

`src/rotation.js` compares the same per-session `rate_limits` against its thresholds, so a session
holding stale numbers can read 96% when the truth is higher. The damage is bounded - thresholds are
re-evaluated every render, and a stale-low reading only postpones a switch until any session renders
fresh figures - but it is the same root cause, not a separate one.

## The limit they all share

Samples accumulate only while the status line renders. During a long subagent run there are none,
so the recent rate goes stale - though it recovers correctly afterwards, because samples are
timestamped rather than counted.
