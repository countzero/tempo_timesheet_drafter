---
name: tempo_timesheet_drafter
description: Draft Tempo timesheet entries (worklogs) for a day or a week from GitHub commits and pull request reviews, calendar meetings and Jira activity, let the user correct them in the chat, then book them in Tempo. Use when the user asks to draft, book, log or fill in time in Tempo, e.g. "Draft my Tempo bookings for today", "buch mir gestern", "log my time for last week", "Zeiten für KW45 erfassen".
---

# Tempo timesheet drafter

The program lies in this skill's base directory. Run it with Node.js 24.2 or newer:
`node <base directory> <command>` (its `package.json` points Node to `tempo_timesheet_drafter.ts`).

## Steps

1. **Draft.** Turn the period the user names into one range and run
   `node <base directory> draft <range>`.
   Ranges: `today` (or `day`), `yesterday`, `week`, `last-week`, `kw45`, `2026-11-03`, `2026-11-02..2026-11-04`
   (German `heute`, `gestern`, `woche`, `letzte-woche` work too).
2. **Describe.** Replace the generic descriptions `Implementation` and `Review` with a short
   description of the work, written from the commit subjects and pull requests (`PR #n title`) in
   the day's `· <ISSUE-KEY>:` line.
   Lines with only Jira activity or views carry the issue summary; shorten it if it is long. Use the
   language and style of the user's booked `#  ✓` lines; without them, ask once. Under each day, `?`
   lines need an answer, `!` lines say how many hours are missing, `·` lines say where lines come
   from (`· calendar:` lists the meetings, which stay at their time; `· viewed:` the quarter-hours
   filled because the user last opened the issue then).
3. **Check** the lines without `?` with `book --dry-run` (same stdin as in step 6). It books nothing,
   lists every problem with its line number (unknown issue, impossible date or time, future date),
   warns about overlaps and prints each day's total against the required hours. Fix what you can
   from the message; ask the user about the rest.
4. **Show** the complete list in a code block. Ask every question that a `?` line or the dry run
   raises: a meeting without issue, a tentative or overlapping meeting, issues active outside the
   drafted lines, commits and pull requests without issue key. Mention a `· batch:` line once: the change to many
   issues was booked on one of them, and the user may name another. Gaps
   are normal (breaks, absences); mention the hours short of the requirement once and let the user
   add time, but never fill gaps on your own.
5. **Correct.** Apply the user's corrections by editing only the lines they concern; copy every other
   line unchanged, since retyping a long list silently loses or alters lines. Keep the format
   `YYYY-MM-DD HH:MM <duration> <ISSUE-KEY> <description>`; durations look like `30m`, `1h`,
   `1h30m`. Run the dry run again, show the complete list again, and repeat until the user approves.
6. **Book** only after an explicit approval of the shown lines ("book", "buchen", "passt"). Pass
   exactly the approved lines on stdin. PowerShell, with single quotes so `$` in a description stays:

   ```powershell
   @'
   2026-11-03 09:30 30m TEAM-1 Daily
   2026-11-03 10:00 2h SHOP-412 Umsetzung Bestellübersicht: CSV-Export
   '@ | node <base directory> book
   ```

   In bash, use a quoted heredoc (`<<'EOF'`). `book` checks every line first; if one fails, it books
   nothing and lists the problems.
7. **Report** the output. Under a header per day, each line starts with `booked <id>`, `skipped`
   (the reason in brackets at the end) or `FAILED` (the reason on the `# ✗` line below the day); the
   last line sums them up. Running `book` again with the same lines is safe: booked lines are
   skipped.

## Rules

- Never run `book` without the user's explicit approval of the concrete lines in this conversation.
  `book --dry-run` is read-only and needs no approval.
- Never pipe `draft` into `book`: the user approves the shown lines, not a fresh draft.
- Never invent hours for a day without evidence; ask the user.
- Lines starting with `#` are comments and are never booked; `#  ✓` lines exist in Tempo already.
  The description runs to the end of the line, `#` included.
- The program prints plain draft lines for you; the week grid and colors are for a person at a
  terminal. `node <base directory> --help` lists commands, ranges and which variables are set.
- Never read, print or commit `.env`. If the program reports a missing variable, point the user to
  the README, section Installation, step "Create a .env file".
- Fix a draft by editing its lines, never by editing the program.
- Do not open Jira issues in the user's browser while drafting: Jira records the view as the user's,
  and the next draft counts it as work.
