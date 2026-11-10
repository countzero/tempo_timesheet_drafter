/**
 * The functions of `tempo_timesheet_drafter.ts` that need no network and no `.env`: ranges, durations, draft lines,
 * the calendar, the planning of a day and the progress lines.
 *
 *   node --run test
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    authoredIn,
    bookedEntry,
    classify,
    closest,
    collapseBatches,
    commitActivities,
    dayNotes,
    duration,
    filledCells,
    fit,
    fitBoth,
    hyperlinks,
    isDate,
    isoWeek,
    issueKey,
    issueUrl,
    jiraActivities,
    keyPieces,
    lanes,
    layoutGrid,
    parseCalendar,
    parseDuration,
    parseLines,
    parseRange,
    planDay,
    planDays,
    pullRequestActivities,
    pullRequestEvents,
    request,
    statusLine,
    summaryLine,
    viewsIn,
    withoutKey,
    wrapFit,
    wrapWords,
} from './tempo_timesheet_drafter.ts';
import type { Activity, Booked, CalendarEvent, Cell, ChangeLog, Commit, Day, DayPlan, DraftLine, Entry, JiraIssue, Mark, Note, PullRequestComment, PullRequestEvent, ReviewedPullRequest, Source, View, ViewedIssue } from './tempo_timesheet_drafter.ts';

// Local time decides the day and the quarter-hours; a fixed zone gives the same results on every machine and in CI.
process.env.TZ = 'Europe/Berlin';

const TODAY = '2026-11-05';
const NOW = new Date('2026-11-05T12:00:00+01:00');
const COMMANDS = ['draft', 'book', 'demo', 'help'];
const PROJECTS = new Set(['SHOP', 'TEAM']);
const DAY: Day = { date: '2026-11-03', requiredSeconds: 7 * 3600, type: 'WORKING_DAY' };

function jira (time: string, issue: string, text = 'status'): Activity {

    const [hours, minutes, seconds = 0] = time.split(':').map(Number);
    const ms = new Date(`${DAY.date}T${time.slice(0, 5)}:${String(seconds).padStart(2, '0')}`).getTime();
    return { date: DAY.date, time: hours * 60 + minutes, ms, issue, kind: 'jira', text, summary: `Summary of ${issue}` };
}

function commit (time: string, issue: string, text = `[${issue}] Change`): Activity {

    return { ...jira(time, issue, text), kind: 'commit', summary: undefined };
}

function spans (entries: Array<{ start: number, minutes: number, issue: string }>): Array<string> {

    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    return entries.map((entry) => `${clock(entry.start)}–${clock(entry.start + entry.minutes)} ${entry.issue}`);
}

/** Notes as the list prints them, mark first. */
function said (notes: Array<Note>): Array<string> {

    return notes.map((each) => `${each.mark} ${each.text}`);
}

function note (text: string): Note {

    return { mark: text[0] as Mark, text: text.slice(2) };
}

function calendar (...lines: Array<string>): Buffer {

    return Buffer.from(['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n'));
}

test('parseDuration reads hours, minutes and both together', () => {

    // Act and Assert
    assert.equal(parseDuration('45m'), 45);
    assert.equal(parseDuration('2h'), 120);
    assert.equal(parseDuration('1h30m'), 90);
    assert.throws(() => parseDuration(''), /Invalid duration/);
    assert.throws(() => parseDuration('90'), /Invalid duration/);
});

test('duration writes what parseDuration reads', () => {

    // Act and Assert
    assert.equal(duration(90), '1h30m');
    assert.equal(duration(60), '1h');
    assert.equal(duration(15), '15m');
});

test('parseRange reads the named ranges relative to today, German ones too', () => {

    // Act and Assert
    assert.deepEqual(parseRange('today', TODAY), ['2026-11-05', '2026-11-05']);
    assert.deepEqual(parseRange('gestern', TODAY), ['2026-11-04', '2026-11-04']);
    assert.deepEqual(parseRange('week', TODAY), ['2026-11-02', '2026-11-08']);
    assert.deepEqual(parseRange('last-week', TODAY), ['2026-10-26', '2026-11-01']);
});

test('parseRange counts kw45 as the ISO week', () => {

    // Act and Assert
    assert.deepEqual(parseRange('kw45', TODAY), ['2026-11-02', '2026-11-08']);
    assert.equal(isoWeek(TODAY), 45);
});

test('parseRange suggests the swapped date or the reversed range', () => {

    // Act and Assert
    assert.throws(() => parseRange('2026-13-01', TODAY), /did you mean 2026-01-13\?/);
    assert.throws(() => parseRange('2026-11-04..2026-11-02', TODAY), /did you mean 2026-11-02\.\.2026-11-04\?/);
    assert.throws(() => parseRange('kw54', TODAY), /kw54 does not exist/);
});

test('isDate accepts real dates only', () => {

    // Act and Assert
    assert.equal(isDate('2026-02-28'), true);
    assert.equal(isDate('2026-02-29'), false);
    assert.equal(isDate('2026-13-01'), false);
});

test('issueKey finds keys of known projects only and withoutKey removes the key with its brackets', () => {

    // Act and Assert
    assert.equal(issueKey('Convert UTF-8 for SHOP-12', PROJECTS), 'SHOP-12');
    assert.equal(issueKey('Convert UTF-8', PROJECTS), undefined);
    assert.equal(withoutKey('[SHOP-12] Daily standup', 'SHOP-12'), 'Daily standup');
});

test('hyperlinks needs the site, not a known terminal, and FORCE_HYPERLINK=0 turns them off', () => {

    // Arrange
    const site = { ATLASSIAN_SITE: 'https://example.atlassian.net' };

    // Act and Assert
    assert.equal(hyperlinks(site), true, 'Windows Terminal after a default-terminal handoff has no WT_SESSION');
    assert.equal(hyperlinks({}), false);
    assert.equal(hyperlinks({ ...site, FORCE_HYPERLINK: '0' }), false);
    assert.equal(hyperlinks({ ...site, FORCE_HYPERLINK: '1' }), true);
    assert.equal(hyperlinks({ ...site, TERM_PROGRAM: 'Apple_Terminal' }), false);
});

test('keyPieces links the keys of known projects in a note and leaves the rest as it is', () => {

    // Arrange
    const url = issueUrl('https://example.atlassian.net/', PROJECTS);

    // Act
    const pieces = keyPieces('also active on SHOP-12, SHOP-7 (UTF-8)', url);

    // Assert
    assert.deepEqual(pieces, [
        { text: 'also active on ' },
        { text: 'SHOP-12', link: 'https://example.atlassian.net/browse/SHOP-12' },
        { text: ', ' },
        { text: 'SHOP-7', link: 'https://example.atlassian.net/browse/SHOP-7' },
        { text: ' (UTF-8)' },
    ]);
    assert.deepEqual(keyPieces('no keys', url), [{ text: 'no keys' }]);
    assert.deepEqual(keyPieces('SHOP-12', issueUrl(undefined, PROJECTS)), [{ text: 'SHOP-12' }]);
});

test('parseLines reads a line and keeps a # in the description', () => {

    // Arrange
    const problems: Array<string> = [];

    // Act
    const lines = parseLines('2026-11-03 10:00 15m TEAM-1 Fix #12 in the parser', problems);

    // Assert
    assert.deepEqual(problems, []);
    assert.deepEqual(lines, [
        { line: 1, date: '2026-11-03', start: 600, minutes: 15, issue: 'TEAM-1', description: 'Fix #12 in the parser' },
    ]);
});

test('parseLines names each stopped line with its number', () => {

    // Arrange
    const problems: Array<string> = [];
    const text = [
        '# ── Tue 2026-11-03 ──',
        '2026-11-03 14:00 1h ? Kundentermin',
        '',
        '2026-11-03 25:00 1h TEAM-1 Daily',
        '2026-11-03 23:45 30m TEAM-1 Daily',
    ].join('\n');

    // Act
    const lines = parseLines(text, problems);

    // Assert
    assert.deepEqual(lines, []);
    assert.deepEqual(problems, [
        'line 2: ? is not an issue yet; replace it with an issue key.',
        'line 4: 25:00 is not a time.',
        'line 5: 23:45 plus 30m runs past midnight.',
    ]);
});

test('parseLines accepts lines in the future', () => {

    // Arrange
    const problems: Array<string> = [];
    const text = ['2026-11-06 09:00 1h TEAM-1 Daily', '2026-11-05 11:45 30m TEAM-1 Daily'].join('\n');

    // Act
    const lines = parseLines(text, problems);

    // Assert
    assert.deepEqual(problems, []);
    assert.deepEqual(lines.map((line) => line.date), ['2026-11-06', '2026-11-05']);
});

test('classify skips a line booked already or repeated and warns about overlaps', () => {

    // Arrange
    const line = (number: number, time: string, minutes: number, issue: string): DraftLine => ({
        line: number, date: DAY.date, start: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), minutes, issue, description: 'Work',
    });
    const ids = new Map([['SHOP-1', 1], ['SHOP-2', 2]]);
    const existing: Array<Booked> = [{ date: DAY.date, start: 540, minutes: 30, issue: 'SHOP-1', issueId: 1, description: 'Work' }];
    const entries = [line(1, '09:00', 30, 'SHOP-1'), line(2, '10:00', 30, 'SHOP-2'), line(3, '10:00', 30, 'SHOP-2'), line(4, '09:15', 30, 'SHOP-2')];

    // Act
    const { planned, warnings } = classify(entries, (key) => ids.get(key)!, existing);

    // Assert
    assert.deepEqual(planned.map((entry) => [entry.line, entry.issueId, entry.duplicate, entry.repeats]), [
        [1, 1, true, undefined],
        [2, 2, false, undefined],
        [3, 2, true, 2],
        [4, 2, false, undefined],
    ]);
    assert.deepEqual(warnings, ['line 4 overlaps booked 09:00–09:30 SHOP-1.']);
});

test('closest suggests a command for a typo or a prefix, nothing for noise', () => {

    // Act and Assert
    assert.equal(closest('drfat', COMMANDS), 'draft');
    assert.equal(closest('bo', COMMANDS), 'book');
    assert.equal(closest('xyz', COMMANDS), undefined);
});

test('parseCalendar expands a weekly meeting and leaves out the excluded day', () => {

    // Arrange
    const raw = calendar(
        'BEGIN:VEVENT',
        'UID:daily',
        'DTSTART;TZID=Europe/Berlin:20261102T093000',
        'DTEND;TZID=Europe/Berlin:20261102T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE',
        'EXDATE;TZID=Europe/Berlin:20261103T093000',
        'SUMMARY:[TEAM-1] Daily',
        'END:VEVENT',
    );

    // Act
    const events = parseCalendar(raw, '2026-11-02', '2026-11-04');

    // Assert
    assert.deepEqual(events.map((event) => `${event.date} ${event.start} ${event.minutes}`), [
        '2026-11-02 570 30',
        '2026-11-04 570 30',
    ]);
});

test('parseCalendar unfolds a line split inside a UTF-8 character and skips canceled meetings', () => {

    // Arrange
    const title = Buffer.from('SUMMARY:Planung Frühjahr', 'utf8');
    const split = title.indexOf(0xc3) + 1;
    const raw = Buffer.concat([
        calendar('BEGIN:VEVENT', 'UID:a', 'DTSTART:20261103T130000', 'DTEND:20261103T140000', '').subarray(0, -'END:VCALENDAR'.length),
        title.subarray(0, split),
        Buffer.from('\r\n '),
        title.subarray(split),
        Buffer.from('\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261103T150000\r\nDTEND:20261103T153000\r\n'),
        Buffer.from('SUMMARY:Abgesagt: Review\r\nEND:VEVENT\r\nEND:VCALENDAR'),
    ]);

    // Act
    const events = parseCalendar(raw, '2026-11-03', '2026-11-03');

    // Assert
    assert.deepEqual(events.map((event) => event.title), ['Planung Frühjahr']);
});

test('collapseBatches counts the same change to three issues within a minute once, for their common parent', () => {

    // Arrange
    const parent = { key: 'SHOP-1', summary: 'Epic' };
    const activities = ['SHOP-2', 'SHOP-3', 'SHOP-4'].map((issue): Activity => ({ ...jira('17:10', issue, 'resolution, status'), parent }));

    // Act
    const collapsed = collapseBatches(activities);

    // Assert
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].issue, 'SHOP-1');
});

test('collapseBatches names the batch issue viewed first, else the one changed first, when there is no parent', () => {

    // Arrange
    const activities = [jira('17:10:10', 'SHOP-2', 'resolution, status'), jira('17:10:20', 'SHOP-3', 'resolution, status'), jira('17:10:30', 'SHOP-4', 'resolution, status')];
    const views: Array<View> = [
        { date: DAY.date, time: 1030, ms: new Date(`${DAY.date}T17:10:18`).getTime(), issue: 'SHOP-3', summary: 'Three' },
        { date: DAY.date, time: 1030, ms: new Date(`${DAY.date}T17:10:28`).getTime(), issue: 'SHOP-4', summary: 'Four' },
    ];

    // Act
    const viewed = collapseBatches(activities, views);
    const changed = collapseBatches(activities);

    // Assert
    assert.deepEqual(viewed.map((activity) => [activity.issue, activity.batch]), [['SHOP-3', ['SHOP-2', 'SHOP-3', 'SHOP-4']]]);
    assert.deepEqual(changed.map((activity) => activity.issue), ['SHOP-2']);
});

test('planDay books a batch on the named issue and lists the others', () => {

    // Arrange
    const activities = collapseBatches(['SHOP-2', 'SHOP-3', 'SHOP-4'].map((issue) => jira('17:10', issue, 'resolution, status')));

    // Act
    const { entries, notes } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['17:00–17:15 SHOP-2']);
    assert.ok(said(notes).includes('· batch: 17:10 SHOP-2 for resolution, status of SHOP-2, SHOP-3, SHOP-4'));
});

test('planDay gives a gap of up to 45 minutes to the issue after it and leaves a longer gap open', () => {

    // Arrange
    const activities = [jira('09:05', 'SHOP-1'), commit('10:05', 'SHOP-2'), commit('12:10', 'SHOP-3')];

    // Act
    const { entries } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['09:00–09:15 SHOP-1', '09:15–10:15 SHOP-2', '12:00–12:15 SHOP-3']);
});

test('planDay places meetings at their time and gives activity during a meeting to the meeting', () => {

    // Arrange
    const meetings: Array<CalendarEvent> = [{ date: DAY.date, start: 570, minutes: 30, title: '[TEAM-1] Daily', tentative: false }];
    const activities = [commit('09:20', 'SHOP-1'), jira('09:40', 'SHOP-2'), commit('10:05', 'SHOP-1')];

    // Act
    const { entries, notes } = planDay(DAY, [], activities, meetings, PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['09:15–09:30 SHOP-1', '09:30–10:00 TEAM-1', '10:00–10:15 SHOP-1']);
    assert.ok(said(notes).some((note) => note.includes('also active on SHOP-2')));
});

test('planDay gives the quarter-hour to the issue with the highest weight', () => {

    // Arrange
    const activities = [jira('09:01', 'SHOP-1'), jira('09:02', 'SHOP-1', 'comment'), commit('09:10', 'SHOP-2')];

    // Act
    const { entries } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['09:00–09:15 SHOP-2']);
});

test('planDay counts changes to one issue within a minute as one action', () => {

    // Arrange
    const activities = [
        jira('15:53:21', 'SHOP-1', 'created'),
        jira('15:54:00', 'SHOP-1', 'Attachment'),
        jira('15:54:05', 'SHOP-1', 'priority'),
        jira('15:59:25', 'SHOP-2', 'assignee'),
    ];

    // Act
    const { entries } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['15:45–16:00 SHOP-2']);
});

test('planDay breaks a tie by the later minute, then by the earlier change, then by the key', () => {

    // Arrange
    const activities = [jira('09:08:28', 'SHOP-2'), jira('09:08:06', 'SHOP-3'), jira('09:00:16', 'SHOP-1')];

    // Act
    const { entries } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['09:00–09:15 SHOP-3']);
});

test('planDay fills open quarter-hours after a view, from the end of the meeting it fell into', () => {

    // Arrange
    const meetings: Array<CalendarEvent> = [{ date: DAY.date, start: 630, minutes: 30, title: '[TEAM-1] Review', tentative: false }];
    const views: Array<View> = [
        { date: DAY.date, time: 657, ms: new Date(`${DAY.date}T10:57:00`).getTime(), issue: 'SHOP-5', summary: 'Show the shipping costs' },
    ];
    const activities = [commit('13:10', 'SHOP-6')];

    // Act
    const { entries, notes } = planDay(DAY, [], activities, meetings, PROJECTS, views, NOW);

    // Assert
    assert.deepEqual(spans(entries), ['10:30–11:00 TEAM-1', '11:00–12:00 SHOP-5', '13:00–13:15 SHOP-6']);
    assert.equal(entries[1].description, 'Show the shipping costs');
    assert.ok(said(notes).includes('· viewed: 11:00–12:00 SHOP-5'));
});

test('planDay ignores issues viewed together within a minute', () => {

    // Arrange
    const at = (issue: string, seconds: number): View => ({
        date: DAY.date, time: 1012, ms: new Date(`${DAY.date}T16:52:${String(seconds).padStart(2, '0')}`).getTime(), issue, summary: issue,
    });
    const views = [at('SHOP-7', 1), at('SHOP-8', 2), at('SHOP-9', 3)];

    // Act
    const { entries } = planDay(DAY, [], [], [], PROJECTS, views, NOW);

    // Assert
    assert.deepEqual(entries, []);
});

function pullRequest (number: number, branch: string, author = 'someone'): ReviewedPullRequest {

    return {
        id: `PR${number}`, number, title: `Title ${number}`, headRefName: branch, author: { login: author },
        repository: { nameWithOwner: 'Shop/web' }, reviews: { totalCount: 0, nodes: [] },
    };
}

function review (state: string, submittedAt: string | null, body = '', comments: Array<[string, string]> = []): NonNullable<ReviewedPullRequest['reviews']>['nodes'][number] {

    return { state, submittedAt, body, comments: { totalCount: comments.length, nodes: comments.map(([createdAt, state]) => ({ createdAt, state })) } };
}

test('pullRequestEvents counts reviews at submission and comments when written, skips replies, pending and other days', () => {

    // Arrange
    const reviewed = pullRequest(1, 'issue/SHOP-1');
    reviewed.reviews!.nodes = [
        review('CHANGES_REQUESTED', '2026-11-03T09:40:00+01:00', '', [['2026-11-03T09:05:00+01:00', 'SUBMITTED'], ['2026-11-03T09:20:00+01:00', 'SUBMITTED']]),
        review('COMMENTED', '2026-11-03T11:00:00+01:00', '', [['2026-11-03T11:00:00+01:00', 'SUBMITTED']]),
        review('APPROVED', '2026-11-04T08:00:00+01:00'),
        review('PENDING', null, '', [['2026-11-03T12:00:00+01:00', 'PENDING']]),
    ];

    // Act
    const events = pullRequestEvents([reviewed, reviewed], [], 'me', ['shop'], '2026-11-03', '2026-11-03');

    // Assert
    assert.deepEqual(events.map((event) => [new Date(event.ms).toTimeString().slice(0, 5), event.kind]), [
        ['09:05', 'pr-comment'], ['09:20', 'pr-comment'], ['09:40', 'pr-review'], ['11:00', 'pr-comment'],
    ]);
});

test('pullRequestEvents keeps conversation comments on pull requests of the owners and marks the own pull request', () => {

    // Arrange
    const comment = (repository: string, pull: ReviewedPullRequest | null): PullRequestComment => ({
        createdAt: '2026-11-03T10:00:00+01:00', updatedAt: '2026-11-03T10:00:00+01:00', repository: { nameWithOwner: repository }, pullRequest: pull,
    });
    const comments = [comment('Shop/web', pullRequest(2, 'x', 'me')), comment('Other/web', pullRequest(3, 'x')), comment('Shop/web', null)];

    // Act
    const events = pullRequestEvents([], comments, 'me', ['shop/WEB'], '2026-11-03', '2026-11-03');

    // Assert
    assert.deepEqual(events.map((event) => [event.pullRequest.number, event.kind, event.own]), [[2, 'pr-comment', true]]);
});

test('pullRequestActivities takes the issue from the branch, also lowercase or with a suffix, else from the title', () => {

    // Arrange
    const event = (branch: string, title: string): PullRequestEvent => ({
        ms: new Date('2026-11-03T10:07:00+01:00').getTime(), kind: 'pr-review', own: false, pullRequest: { number: 5, title, branch },
    });

    // Act
    const activities = pullRequestActivities([
        event('feature/shop-12_checkout', 'SHOP-99 Checkout'),
        event('develop', 'SHOP-13: Cart'),
        event('UTF-8', 'Bump'),
    ], PROJECTS);

    // Assert
    assert.deepEqual(activities.map((activity) => [activity.issue, activity.time, activity.text]), [
        ['SHOP-12', 607, 'PR #5 SHOP-99 Checkout'], ['SHOP-13', 607, 'PR #5 SHOP-13: Cart'], [undefined, 607, 'PR #5 Bump'],
    ]);
});

test('planDay describes reviews of others as Review and comments on the own pull request as Implementation', () => {

    // Arrange
    const pull = (time: string, issue: string, kind: Activity['kind'], own = false): Activity => ({ ...jira(time, issue, `PR #1 ${issue}`), kind, summary: undefined, ...(own ? { own } : {}) });
    const activities = [pull('09:05', 'SHOP-1', 'pr-comment'), pull('09:20', 'SHOP-1', 'pr-review'), pull('11:05', 'SHOP-2', 'pr-comment', true)];

    // Act
    const { entries } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(entries.map((entry) => [entry.issue, entry.description, entry.evidence]), [
        ['SHOP-1', 'Review', 'PR #1 SHOP-1'], ['SHOP-2', 'Implementation', 'PR #1 SHOP-2'],
    ]);
});

test('planDay weighs a pull request comment like a commit, above two Jira changes, and a review like one', () => {

    // Arrange
    const pull = (time: string, issue: string, kind: Activity['kind']): Activity => ({ ...jira(time, issue), kind, summary: undefined });
    const activities = [
        pull('09:01', 'SHOP-2', 'pr-comment'), commit('09:02', 'SHOP-1'),
        pull('10:01', 'SHOP-5', 'pr-comment'), jira('10:02', 'SHOP-6'), jira('10:05', 'SHOP-6', 'comment'),
        jira('12:01', 'SHOP-3'), pull('12:02', 'SHOP-4', 'pr-review'),
    ];

    // Act
    const { entries } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.deepEqual(spans(entries), ['09:00–09:15 SHOP-1', '09:15–10:15 SHOP-5', '12:00–12:15 SHOP-4']);
});

test('planDay lists a pull request without issue key once, however often it was commented', () => {

    // Arrange
    const keyless = (time: string, kind: Activity['kind'], text: string): Activity => ({ ...jira(time, '', text), issue: undefined, kind, summary: undefined });
    const activities = [keyless('09:00', 'commit', 'Bump'), keyless('09:10', 'pr-comment', 'PR #4 Docs'), keyless('09:20', 'pr-comment', 'PR #4 Docs')];

    // Act
    const { notes } = planDay(DAY, [], activities, [], PROJECTS);

    // Assert
    assert.ok(said(notes).includes('? 1 commit(s), 1 pull request(s) without issue key: Bump; PR #4 Docs'));
});

function source (name: string, overrides: Partial<Source> = {}): Source {

    return { name, steps: 1, done: 0, failed: false, started: 0, details: [], ...overrides };
}

function fetching (): Array<Source> {

    return [
        source('Tempo', { steps: 2, done: 2, details: ['23 worklogs'] }),
        source('Jira', { steps: 4, done: 2 }),
        source('Calendar', { failed: true }),
        source('GitHub', { started: 5000, count: { total: 31, unit: 'repos', skipped: 0 } }),
    ];
}

test('statusLine keeps the order of the sources and shows the wait from 3 seconds', () => {

    // Act
    const line = statusLine(fetching(), 7000, 120);

    // Assert
    assert.equal(line, ' ⠋ Tempo ✓  Jira … 7s  Calendar ✗  GitHub …');
});

test('statusLine leaves out finished sources first and never reaches the last column', () => {

    // Act
    const narrow = statusLine(fetching(), 7000, 40);
    const tiny = statusLine(fetching(), 7000, 20);
    const widths = Array.from({ length: 70 }, (_, index) => statusLine(fetching(), 7000, index + 10).length - (index + 10));

    // Assert
    assert.equal(narrow, ' ⠋ Jira … 7s  Calendar ✗  GitHub …');
    assert.equal(tiny, ' ⠋ Jira … 7s  Cale…');
    assert.ok(widths.every((overflow) => overflow < 0));
});

test('summaryLine puts the counts first and the time last, with skipped repositories', () => {

    // Arrange
    const sources = [
        source('Tempo', { steps: 2, done: 2, details: ['23 worklogs'] }),
        source('Jira', { steps: 4, done: 4, details: ['42 changes', '17 views'] }),
        source('Calendar', { done: 1, details: ['9 meetings'] }),
        source('GitHub', { steps: 2, done: 2, details: ['87 commits', '4 reviews, 11 comments'], count: { total: 31, unit: 'repos', skipped: 2 } }),
    ];

    // Act
    const line = summaryLine(sources, 6.31);

    // Assert
    assert.equal(line, '✓ Tempo 23 worklogs · Jira 42 changes, 17 views · Calendar 9 meetings · GitHub 29/31 repos (2 skipped), 87 commits, 4 reviews, 11 comments · 6.3s');
});

test('summaryLine stays below the last column: first counts, then names, then cut', () => {

    // Arrange
    const sources = [
        source('Tempo', { steps: 2, done: 2, details: ['46 worklogs'] }),
        source('Jira', { steps: 4, done: 4, details: ['157 changes', '46 views'] }),
        source('Calendar', { done: 1, details: ['9 meetings'] }),
        source('GitHub', { steps: 2, done: 2, details: ['24 commits', '4 reviews, 10 comments'], count: { total: 17, unit: 'repos', skipped: 0 } }),
    ];

    // Act
    const wide = summaryLine(sources, 5.1, 135);
    const medium = summaryLine(sources, 5.1, 100);
    const narrow = summaryLine(sources, 5.1, 60);
    const tiny = summaryLine(sources, 5.1, 31);

    // Assert
    assert.equal(wide, '✓ Tempo 46 worklogs · Jira 157 changes, 46 views · Calendar 9 meetings · GitHub 17 repos, 24 commits, 4 reviews, 10 comments · 5.1s');
    assert.equal(medium, '✓ Tempo 46 worklogs · Jira 157 changes · Calendar 9 meetings · GitHub 24 commits · 5.1s');
    assert.equal(narrow, '✓ Tempo · Jira · Calendar · GitHub · 5.1s');
    assert.equal(tiny, '✓ Tempo · Jira · Calendar · G…');
});

test('filledCells fills the rule toward the required hours and stays full beyond them', () => {

    // Act
    const cells = [[0, 420], [120, 420], [435, 420], [60, 0]].map(([done, required]) => filledCells(done, required, 24));

    // Assert
    assert.deepEqual(cells, [0, 7, 24, 0]);
});

test('summaryLine after a failure keeps what the other sources brought and marks the failed one', () => {

    // Arrange
    const sources = fetching().map((each) => each.name === 'Calendar' ? source('Calendar') : each.name === 'Jira' ? { ...each, failed: true } : each);

    // Act
    const line = summaryLine(sources, 12.4);

    // Assert
    assert.equal(line, '✗ Fetch failed: Tempo 23 worklogs · Jira ✗ · Calendar … · GitHub … · 12s');
});

test('request retries after 429 with the user agent, but never repeats a POST after a 5xx', async (context) => {

    // Arrange
    const statuses = [429, 200, 503];
    const seen: Array<string> = [];
    context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        seen.push(`${init.method} ${(init.headers as Record<string, string>)['user-agent']}`);
        return new Response('', { status: statuses.shift() });
    });

    // Act
    const get = await request('https://example.test/a', 'GET', {});
    const post = await request('https://example.test/b', 'POST', {}, '{}');

    // Assert
    assert.deepEqual([get.status, post.status], [200, 503]);
    assert.deepEqual(seen, ['GET tempo_timesheet_drafter', 'GET tempo_timesheet_drafter', 'POST tempo_timesheet_drafter']);
});

test('jiraActivities keeps what the account did in the range: creations, all comments and changes once per field', () => {

    // Arrange
    const me = { accountId: 'me' };
    const other = { accountId: 'other' };
    const issue: JiraIssue = {
        id: '10',
        key: 'SHOP-1',
        fields: {
            summary: 'Checkout',
            created: `${DAY.date}T08:00:00+01:00`,
            creator: me,
            parent: { key: 'SHOP-0', fields: { summary: 'Epic' } },
            comment: { total: 3, comments: [{ created: `${DAY.date}T08:30:00+01:00`, author: me }] },
        },
    };
    const more = new Map([['SHOP-1', [
        { created: `${DAY.date}T08:30:00+01:00`, author: me },
        { created: `${DAY.date}T09:00:00+01:00`, author: other },
        { created: '2026-11-04T09:00:00+01:00', author: me },
    ]]]);
    const logs: Array<ChangeLog> = [{ issueId: 10, changeHistories: [
        { author: me, created: new Date(`${DAY.date}T10:00:00+01:00`).getTime(), items: [{ field: 'status' }, { field: 'resolution' }, { field: 'status' }] },
        { author: other, created: new Date(`${DAY.date}T11:00:00+01:00`).getTime(), items: [{ field: 'status' }] },
    ] }];

    // Act
    const activities = jiraActivities([issue], more, logs, 'me', DAY.date, DAY.date);

    // Assert
    assert.deepEqual(activities.map((activity) => [activity.time, activity.text, activity.parent?.key]), [
        [480, 'created', 'SHOP-0'],
        [510, 'comment', 'SHOP-0'],
        [600, 'status, resolution', 'SHOP-0'],
    ]);
});

test('viewsIn keeps the views of the range in time order', () => {

    // Arrange
    const viewed = (key: string, at: string): ViewedIssue => ({ key, fields: { lastViewed: at, summary: key } });

    // Act
    const views = viewsIn([viewed('SHOP-2', `${DAY.date}T11:00:00+01:00`), viewed('SHOP-1', `${DAY.date}T09:00:00+01:00`), viewed('SHOP-3', '2026-11-04T00:30:00+01:00')], DAY.date, DAY.date);

    // Assert
    assert.deepEqual(views.map((view) => [view.issue, view.time]), [['SHOP-1', 540], ['SHOP-2', 660]]);
});

test('bookedEntry names an issue Jira does not know by its id and keeps the first line of the description', () => {

    // Act
    const entry = bookedEntry(
        { tempoWorklogId: 1, issue: { id: 7 }, startDate: DAY.date, startTime: '09:30:00', timeSpentSeconds: 1800, description: `${'x'.repeat(70)}\nsecond line` },
        new Map(),
    );

    // Assert
    assert.deepEqual(entry, { date: DAY.date, start: 570, minutes: 30, issue: '#7', issueId: 7, description: 'x'.repeat(60) });
});

test('authoredIn keeps each commit once and only those authored in the range', () => {

    // Arrange
    const node = (oid: string, authoredDate: string): Commit => ({ oid, authoredDate, messageHeadline: oid, parents: { totalCount: 1 } });

    // Act
    const kept = authoredIn([node('a', `${DAY.date}T09:00:00+01:00`), node('a', `${DAY.date}T09:00:00+01:00`), node('b', '2026-11-02T23:30:00+01:00')], DAY.date, DAY.date);

    // Assert
    assert.deepEqual(kept.map((each) => each.oid), ['a']);
});

test('commitActivities counts a pull request merge as a review and skips other merges without an issue key', () => {

    // Arrange
    const node = (headline: string, parents = 1): Commit => ({ oid: headline, authoredDate: `${DAY.date}T09:05:00+01:00`, messageHeadline: headline, parents: { totalCount: parents } });
    const commits = [
        node('[SHOP-1] Validate the address'),
        node('Merge pull request #7 from shop/issue/SHOP-2', 2),
        node('Merge develop into issue/SHOP-3', 2),
        node('Merge branch develop', 2),
        node('Bump dependencies'),
    ];

    // Act
    const activities = commitActivities(commits, PROJECTS);

    // Assert
    assert.deepEqual(activities.map((activity) => [activity.kind, activity.issue, activity.time]), [
        ['commit', 'SHOP-1', 545],
        ['review', 'SHOP-2', 545],
        ['merge', 'SHOP-3', 545],
        ['commit', undefined, 545],
    ]);
});

test('lanes puts overlapping entries side by side and widens an entry into a lane that is free beside it', () => {

    // Arrange
    const entry = (start: number, minutes: number, issue: string) => ({ entry: { date: DAY.date, start, minutes, issue, description: '' }, booked: false });
    const entries = [entry(540, 60, 'A'), entry(540, 15, 'B'), entry(540, 15, 'C'), entry(555, 45, 'D'), entry(660, 15, 'E')];

    // Act
    const { placed, hidden } = lanes(entries, 3);
    const narrow = lanes(entries, 2);

    // Assert
    assert.deepEqual(placed.map((item) => `${item.issue} ${item.lane}+${item.span}/${item.lanes}`), ['A 0+1/3', 'B 1+1/3', 'C 2+1/3', 'D 1+2/3', 'E 0+1/1']);
    assert.deepEqual(hidden, []);
    assert.deepEqual(narrow.hidden.map((item) => item.issue), ['C']);
});

test('dayNotes puts questions first, then missing hours, then the sources of the lines', () => {

    // Arrange
    const entries: Array<Entry> = [
        { date: DAY.date, start: 540, minutes: 30, issue: 'TEAM-1', description: 'Daily', meeting: true },
        { date: DAY.date, start: 600, minutes: 60, issue: '?', description: 'Kundentermin', meeting: true, question: 'Which issue?' },
        { date: DAY.date, start: 660, minutes: 60, issue: 'SHOP-1', description: 'Implementation', evidence: 'Validate the address' },
    ];

    // Act
    const notes = dayNotes(entries, ['· batch: 17:10 SHOP-2', '! 30m short of 7h', '? also active on SHOP-3'].map(note));

    // Assert
    assert.deepEqual(said(notes), [
        '? 10:00 Kundentermin: Which issue?',
        '? also active on SHOP-3',
        '! 30m short of 7h',
        '· batch: 17:10 SHOP-2',
        '· calendar: 09:00 TEAM-1, 10:00 ?',
        '· SHOP-1: Validate the address',
    ]);
});

test('fit, fitBoth, wrapFit and wrapWords measure in cells, wide characters count two', () => {

    // Act and Assert
    assert.equal(fit('abcdef', 4), 'abc…');
    assert.equal(fit('日本語', 4), '日…');
    assert.equal(fitBoth('Mon 02', '8h/7h', 12), 'Mon 02 8h/7h');
    assert.equal(fitBoth('Monday long', '8h', 8), 'Mond… 8h');
    assert.deepEqual(wrapFit('one two three four', 9, 2), ['one two', 'three fo…']);
    assert.deepEqual(wrapWords('aaaaaaaaaa bb', 4), ['aaaa', 'aaaa', 'aa', 'bb']);
});

test('layoutGrid fills the rule toward the required hours, colors the entry running now and draws the now line in free cells', () => {

    // Arrange
    const day: DayPlan = {
        date: DAY.date,
        required: 60,
        booked: [],
        entries: [{ date: DAY.date, start: 570, minutes: 30, issue: 'SHOP-1', description: 'Review' }],
        notes: [],
    };
    const text = (rows: Array<Array<Cell>>) => rows.map((row) => row.map((cell) => cell.ch).join('').trimEnd());

    // Act
    const during = layoutGrid([day], new Date(`${DAY.date}T09:40:00`), 30, 24, () => undefined);
    const after = layoutGrid([day], new Date(`${DAY.date}T10:10:00`), 30, 24, () => undefined);
    const narrow = layoutGrid([day], new Date(`${DAY.date}T10:10:00`), 14, 24, () => undefined);

    // Assert
    assert.ok(during && after);
    assert.deepEqual(text(during.rows).slice(0, 2), ['      │Tue 03           30m/1h', `──────┼${'━'.repeat(12)}${'─'.repeat(11)}`]);
    assert.equal(text(during.rows)[8], '09:40 │▌SHOP-1 Review');
    assert.deepEqual(during.rows[8][8].bg, [213, 94, 0]);
    assert.deepEqual(after.rows[8][8].bg, [86, 180, 233]);
    assert.equal(text(after.rows)[10], `10:00 │${'─'.repeat(23)}`);
    assert.deepEqual(during.hidden, []);
    assert.equal(narrow, undefined);
});

interface Span {
    date: string;
    start: number;
    minutes: number;
    issue: string;
    byTool?: boolean;
}

interface Score {
    same: number;
    other: number;
    missing: number;
    extra: number;
}

interface Fixture {
    capturedAt: string;
    projects: Array<string>;
    days: Array<Day>;
    activities: Array<Activity>;
    meetings: Array<CalendarEvent>;
    views: Array<View>;
    booked: Array<Span>;
    tempo: Array<Span>;
}

/** Per quarter-hour: the planned issue against a reference, on the days the reference covers. */
function score (planned: Array<Span>, reference: Array<Span>): Score {

    const result: Score = { same: 0, other: 0, missing: 0, extra: 0 };
    const slots = (list: Array<Span>) => new Map(list.flatMap((span) => Array.from(
        { length: span.minutes / 15 },
        (_, index): [string, string] => [`${span.date} ${span.start + index * 15}`, span.issue],
    )));
    const want = slots(reference);
    const days = new Set(reference.map((span) => span.date));
    const got = slots(planned.filter((span) => days.has(span.date)));
    for (const slot of new Set([...want.keys(), ...got.keys()])) {
        const wanted = want.get(slot);
        const drafted = got.get(slot);
        if (wanted === drafted) result.same++;
        else if (!drafted) result.missing++;
        else if (!wanted) result.extra++;
        else result.other++;
    }
    return result;
}

// Booked days are the reference that counts: a rule change must not lower bookedByHand.same. Days booked from this
// tool's draft agree with it by construction and are scored apart; Tempo's suggestions only break ties.
const FIXTURE = new URL('tempo_timesheet_drafter.fixture.json', import.meta.url);
test('planDay against the booked days and Tempo\'s suggestions of the fixture', { skip: !existsSync(FIXTURE) && 'the fixture holds real working hours and stays local' }, () => {

    // Arrange
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
    const projects = new Set(fixture.projects);
    const captured = new Date(fixture.capturedAt);

    // Act
    const planned = planDays(fixture.days, [], fixture.activities, fixture.meetings, fixture.views, projects, captured).flatMap((day) => day.entries);

    // Assert
    assert.deepEqual({
        bookedByHand: score(planned, fixture.booked.filter((span) => !span.byTool)),
        bookedByTool: score(planned, fixture.booked.filter((span) => span.byTool)),
        tempo: score(planned, fixture.tempo),
    }, {
        bookedByHand: { same: 112, other: 46, missing: 118, extra: 21 },
        bookedByTool: { same: 30, other: 1, missing: 2, extra: 2 },
        tempo: { same: 59, other: 21, missing: 8, extra: 18 },
    });
});
