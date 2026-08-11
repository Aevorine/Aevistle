# Aevistle 0.1.13

The one thing 0.1.11 flagged and left open: toggling a day on the working
calendar, with a real number of reminders loaded, still felt like a pause.

## What was actually slow

Every calendar edit rebuilds the occurrence list of every reminder that opted
into the calendar — that part is required, not a bug, because it is the whole
reason marking a day off actually moves the reminder instead of just repainting
a preview. What was wrong was *how* it rebuilt: `computeOccurrences` reruns a
day-by-day search for each reminder's next 24 fire times from its rule, and
that search does not depend on the calendar at all — only the *shaping* of the
result does. Every edit was re-running the expensive half to get an answer
that, for the reminder's own timing, had not changed.

The rule-level occurrence list is now cached on the reminder and reused across
edits, reshaped against whichever calendar is current. The cache is tied to
the run count it was built against and re-validated on every use, so a
reminder that has since fired, or whose cache has gone stale, falls back to a
full rebuild automatically — never a stale send time, only a slower one on the
rare edit that needs it.

Measured with 300 calendar-bound reminders (a mix of daily, weekly, monthly and
yearly rules): the first edit in a session — cold, no cache yet — costs what it
always did. Every edit after that is a different order of magnitude, because
the search that dominated the cost no longer runs at all; a CPU profile of a
"warm" edit no longer shows the occurrence search anywhere in it.

**Also found while chasing this number, not yet fixed:** even with the rebuild
gone, a 300-reminder calendar screen's own re-render — the send-load heatmap,
the per-day formatted labels, a conflict rescan — is now the larger of the two
costs where it used to be the smaller one. Toggling a day is faster than 0.1.12
and still not instant at that scale. Left open on purpose, the same way the
rebuild cost was: a number reported honestly beats a screen that quietly still
lags.

## Guarded

`check:workcal` gained assertions for the cache specifically: that a cache-hit
edit produces the identical answer a full rebuild would have, that a run
advancing past what the cache was computed against is never resurrected by the
next calendar edit, and that a calendar edit whose visible answer happens not
to change still heals a stale cache rather than leaving it stale forever. Each
one was checked against a deliberately broken version first, to confirm it
fails red before trusting it green.
