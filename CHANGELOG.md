# Changelog

This changelog follows [Common Changelog](https://common-changelog.org) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-06

### Changed
- Fill the rule under each day of the grid toward the required hours, green with ✓ once they are reached, like the list's day headers.
- Show the grid entry running now in orange instead of underlining it.
- Shorten the summary line after fetching and keep it in one row: too wide, each source keeps its first count, then only its name.

### Added
- Show the week grid of `demo` as an image in the README, with badges and links to support the project.

### Fixed
- Keep the background of the grid row at the current time in Windows Terminal, which dropped it for the underline color.

## 1.0.0 - 2026-11-05

### Added
- Add a single dependency-free TypeScript file with `draft`, `book`, `demo` and `help`, run directly by Node.js 24.2 or newer.
- Draft worklogs from your GitHub commits on every branch committed to since the range's start, your merges and your pull request reviews and comments.
- Read meetings from a private iCal link, recurrences, exceptions and Outlook's Windows time zones included.
- Read the Jira issues you created, changed or commented on, and the last time you opened each issue.
- Read required hours, holidays and existing worklogs from Tempo, and draft every day of the range, weekends and holidays included.
- Plan every day in quarter-hours by weighted activity, fill gaps of up to 45 minutes and leave longer ones open.
- Count one Jira action, and the same change to three or more issues within a minute of each other, once.
- Fill open quarter-hours from the last time you opened an issue in Jira.
- List open questions, missing hours and the sources of the lines under each day.
- Show the draft as a colored week grid at a terminal, with issue keys linking to Jira, and as plain lines for files, pipes and agents.
- Accept the ranges `today`, `yesterday`, `week`, `last-week`, `kw45`, dates and date ranges, also in German.
- Check every line before `book` posts the first one, skip duplicates, warn about overlaps and send the remaining estimate with each worklog.
- Add `book --dry-run`, which checks the lines and shows the day totals without booking.
- Show each source's state on stderr while fetching, and one summary line after it.
- Add the agent skill `SKILL.md`, which drafts, describes the work, asks about open points and books only after your approval.
- Add a `node:test` suite that scores the planning against real booked days.
- Add the README, `AGENTS.md` and the MIT license.

[1.1.0]: https://github.com/countzero/tempo_timesheet_drafter/releases/tag/v1.1.0
