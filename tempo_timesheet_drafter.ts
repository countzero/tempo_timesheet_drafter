#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export interface Entry {
  date: string;
  start: number;
  minutes: number;
  issue: string;
  description: string;
  // Not on the entry line: what the user approves must be exactly what book reads, so these go to "#" lines.
  question?: string;
  evidence?: string;
  meeting?: boolean;
}

export interface Booked extends Entry {
  issueId: number;
}

// "review" is the merge commit of a pull request, kept apart from the user's own reviews and comments ("pr-review",
// "pr-comment") so the fixture's merges keep their weight.
export type ActivityKind = "commit" | "review" | "merge" | "jira" | "pr-review" | "pr-comment";

export interface Activity {
  date: string;
  time: number;
  /** Epoch milliseconds, for the order within a minute. */
  ms: number;
  issue?: string;
  kind: ActivityKind;
  text: string;
  /** On the user's own pull request: answering reviewers is part of the implementation. */
  own?: boolean;
  summary?: string;
  parent?: { key: string; summary: string };
  /** The issues of a batch change without a common parent, in the order they changed. */
  batch?: string[];
}

/** The user's last view of a Jira issue; Jira keeps only the latest per issue. */
export interface View {
  date: string;
  time: number;
  ms: number;
  issue: string;
  summary: string;
}

export interface CalendarEvent {
  date: string;
  start: number;
  minutes: number;
  title: string;
  tentative: boolean;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    created: string;
    creator?: { accountId: string };
    parent?: { key: string; fields: { summary: string } };
    comment?: { total: number; comments: JiraComment[] };
  };
}

interface JiraComment {
  created: string;
  author?: { accountId: string };
}

export interface Day {
  date: string;
  requiredSeconds: number;
  type: string;
  holiday?: { name: string };
}

interface TempoWorklog {
  tempoWorklogId: number;
  issue: { id: number };
  startDate: string;
  startTime?: string;
  timeSpentSeconds: number;
  description?: string;
}

interface Stamp {
  date: string;
  time: number;
  zone: string;
}

interface Transition {
  offset: number;
  start: Stamp;
  month?: number;
  byDay?: string;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

const ENV_FILE = join(import.meta.dirname, ".env");
const TEMPO_BASE_URL = "https://api.tempo.io";
const STEP = 15;
const MAX_GAP = 45;
const BATCH_SIZE = 3;
const ACTION_MS = 60_000;
const MEETING_TAIL = 5;
const WEIGHT: Record<ActivityKind, number> = { commit: 3, review: 2, merge: 2, jira: 1, "pr-review": 1, "pr-comment": 3 };
const DESCRIPTION_COMMIT = "Implementation";
const DESCRIPTION_REVIEW = "Review";
const ISSUE_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const VALID_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
// The description runs to the end of the line: a "#" in a Jira summary or meeting title is part of it.
const LINE = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(\S+)\s+(\S+)\s+(.+)$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const CANCELLED = /^(abgesagt|canceled|cancelled|annulé|cancelado)\s*:/i;
const PLACEHOLDER_TITLES = new Set(["", "busy", "beschäftigt", "free", "frei", "tentative", "mit vorbehalt", "away", "abwesend"]);

const USAGE_DRAFT = "node . draft <range> [--grid|--list]";
const USAGE_BOOK = "node . book [--dry-run] [<file>]";
const USAGE_DEMO = "node . demo [--grid|--list]";
const RANGE_HINT = 'Run "node . draft --help" for all range forms.';
const DRAFT_VARIABLES = ["TEMPO_API_TOKEN", "ATLASSIAN_SITE", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "GITHUB_TOKEN", "GITHUB_OWNERS"];
const BOOK_VARIABLES = DRAFT_VARIABLES.slice(0, 4);

/** A mistake in the command line: printed with the relevant usage line, exit code 2. */
export class UsageError extends Error {
  usage: string;
  hint: string;
  constructor(message: string, usage: string, hint: string) {
    super(message);
    this.usage = usage;
    this.hint = hint;
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See README.md.`);
  return value;
}

/** All missing variables at once, before the first request. */
function requireEnv(names: string[]): void {
  const missing = names.filter((name) => !process.env[name]);
  if (!missing.length) return;
  throw new Error(
    `missing in .env: ${missing.join(", ")}\n.env: ${ENV_FILE} (${existsSync(ENV_FILE) ? "found" : "not found"})\n` +
      'README.md, section Installation, explains each value; variables set in the environment work too. "node . --help" shows which are set.',
  );
}

// --- time and dates -------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function clock(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function parseDuration(text: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (!match || (!match[1] && !match[2])) throw new Error(`Invalid duration "${text}", expected e.g. 30m, 1h, 1h30m.`);
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours ? `${hours}h` : ""}${rest || !hours ? `${rest}m` : ""}`;
}

function localDate(value: Date): string {
  return value.toLocaleDateString("sv-SE");
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekday(date: string): string {
  return WEEKDAYS[dayOfWeek(date)];
}

function mondayOf(date: string): string {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

export function parseRange(input: string, today: string): [string, string] {
  const text = input.toLowerCase().replace(/\s+/g, "");
  if (text === "today" || text === "day" || text === "heute") return [today, today];
  if (text === "yesterday" || text === "gestern") return [addDays(today, -1), addDays(today, -1)];
  if (text === "week" || text === "woche") return [mondayOf(today), addDays(mondayOf(today), 6)];
  if (text === "last-week" || text === "letzte-woche") {
    const monday = addDays(mondayOf(today), -7);
    return [monday, addDays(monday, 6)];
  }
  const week = /^(?:(\d{4})-)?k?w(\d{1,2})$/.exec(text);
  if (week) {
    if (Number(week[2]) < 1 || Number(week[2]) > 53) throw new UsageError(`kw${week[2]} does not exist; weeks run from kw1 to kw53`, USAGE_DRAFT, RANGE_HINT);
    const year = week[1] ?? today.slice(0, 4);
    const monday = addDays(mondayOf(`${year}-01-04`), (Number(week[2]) - 1) * 7);
    return [monday, addDays(monday, 6)];
  }
  const range = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(text);
  if (range) {
    const [from, to = from] = range.slice(1).filter(Boolean);
    for (const date of [from, to]) {
      if (isDate(date)) continue;
      const swapped = `${date.slice(0, 4)}-${date.slice(8)}-${date.slice(5, 7)}`;
      throw new UsageError(`"${date}" is not a date${isDate(swapped) ? `; did you mean ${swapped}?` : " (YYYY-MM-DD)"}`, USAGE_DRAFT, RANGE_HINT);
    }
    if (from > to) throw new UsageError(`range "${input}" ends before it starts; did you mean ${to}..${from}?`, USAGE_DRAFT, RANGE_HINT);
    return [from, to];
  }
  throw new UsageError(`unknown range "${input}"`, USAGE_DRAFT, RANGE_HINT);
}

/** ISO week number, as kw45 in parseRange counts it. */
export function isoWeek(date: string): number {
  const thursday = addDays(mondayOf(date), 3);
  return Math.floor(dayDiff(mondayOf(`${thursday.slice(0, 4)}-01-04`), mondayOf(date)) / 7) + 1;
}

// --- issue keys -----------------------------------------------------------

export function issueKey(text: string, projects: Set<string>): string | undefined {
  return text.match(ISSUE_KEY)?.find((key) => projects.has(key.slice(0, key.lastIndexOf("-"))));
}

export function withoutKey(text: string, key: string): string {
  return text.replace(key, "").replace(/^[\s:–|[\]()-]+|[\s:–|[\]()-]+$/g, "").replace(/\s{2,}/g, " ") || text;
}

// --- APIs -----------------------------------------------------------------

async function call<T>(url: string, authorization: string, method = "GET", body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: {
        authorization,
        accept: "application/json",
        "user-agent": "tempo_timesheet_drafter",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const retry = response.status === 429 || (response.status >= 500 && method === "GET");
    if (retry && attempt <= 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * (response.status === 429 ? 1000 : 5000)));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${method} ${new URL(url).pathname} failed with ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function tempo<T>(path: string, method?: string, body?: unknown): Promise<T> {
  return call<T>(TEMPO_BASE_URL + path, `Bearer ${env("TEMPO_API_TOKEN")}`, method, body);
}

function jira<T>(path: string, method?: string, body?: unknown): Promise<T> {
  const credentials = Buffer.from(`${env("ATLASSIAN_EMAIL")}:${env("ATLASSIAN_API_TOKEN")}`).toString("base64");
  return call<T>(env("ATLASSIAN_SITE").replace(/\/$/, "") + path, `Basic ${credentials}`, method, body);
}

function githubCall<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors?: { message: string }[] }> {
  return call("https://api.github.com/graphql", `Bearer ${env("GITHUB_TOKEN")}`, "POST", { query, variables });
}

async function github<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const result = await githubCall<T>(query, variables);
  if (result.errors?.length) throw new Error(`GitHub: ${result.errors.map((error) => error.message).join("; ")}`);
  return result.data!;
}

/** Keeps what GitHub returned beside errors (a pull request in a repository the token may not read) as warnings. */
async function githubPartial<T>(query: string, variables: Record<string, unknown>, warnings: string[]): Promise<T | null> {
  const result = await githubCall<T>(query, variables);
  for (const error of result.errors ?? []) warnings.push(`GitHub: ${error.message}`);
  return result.data;
}

async function accountId(): Promise<string> {
  return (await jira<{ accountId: string }>("/rest/api/3/myself")).accountId;
}

async function projectKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let startAt = 0; ; startAt += 100) {
    const page = await jira<{ values: { key: string }[]; isLast: boolean }>(`/rest/api/3/project/search?startAt=${startAt}&maxResults=100`);
    for (const project of page.values) keys.add(project.key);
    if (page.isLast || !page.values.length) return keys;
  }
}

async function issueKeys(ids: number[]): Promise<Map<number, string>> {
  const keys = new Map<number, string>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const page = await jira<{ issues: { id: string; key: string }[] }>("/rest/api/3/search/jql", "POST", {
      jql: `id in (${chunk.join(",")})`,
      fields: ["summary"],
      maxResults: 100,
    });
    for (const issue of page.issues) keys.set(Number(issue.id), issue.key);
  }
  return keys;
}

async function issue(key: string): Promise<{ id: number; remainingSeconds: number } | undefined> {
  try {
    const found = await jira<{ id: string; fields: { timetracking?: { remainingEstimateSeconds?: number } } }>(`/rest/api/3/issue/${key}?fields=timetracking`);
    return { id: Number(found.id), remainingSeconds: found.fields.timetracking?.remainingEstimateSeconds ?? 0 };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

async function comments(key: string): Promise<JiraComment[]> {
  const result: JiraComment[] = [];
  for (let startAt = 0; ; startAt += 100) {
    const page = await jira<{ comments: JiraComment[]; total: number }>(`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100`);
    result.push(...page.comments);
    if (!page.comments.length || result.length >= page.total) return result;
  }
}

async function jiraActivity(account: string, from: string, to: string): Promise<Activity[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page: { issues: JiraIssue[]; nextPageToken?: string } = await jira("/rest/api/3/search/jql", "POST", {
      jql: `issuekey in updatedBy("${account}", "${from}", "${to}")`,
      fields: ["summary", "created", "creator", "parent", "comment"],
      maxResults: 100,
      nextPageToken,
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);

  const result: Activity[] = [];
  const add = (stamp: string | number, issue: JiraIssue, text: string) => {
    const at = new Date(stamp);
    const date = localDate(at);
    if (date < from || date > to) return;
    const parent = issue.fields.parent && { key: issue.fields.parent.key, summary: issue.fields.parent.fields.summary };
    result.push({ date, time: at.getHours() * 60 + at.getMinutes(), ms: at.getTime(), issue: issue.key, kind: "jira", text, summary: issue.fields.summary, parent });
  };
  for (const issue of issues) {
    if (issue.fields.creator?.accountId === account) add(issue.fields.created, issue, "created");
    const listed = issue.fields.comment?.comments ?? [];
    const all = (issue.fields.comment?.total ?? 0) > listed.length ? await comments(issue.key) : listed;
    for (const comment of all) if (comment.author?.accountId === account) add(comment.created, issue, "comment");
  }

  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  type Histories = { issueId: string | number; changeHistories: { author?: { accountId: string }; created: number; items: { field: string }[] }[] };
  for (let index = 0; index < issues.length; index += 1000) {
    let token: string | undefined;
    do {
      const page: { issueChangeLogs: Histories[]; nextPageToken?: string } = await jira("/rest/api/3/changelog/bulkfetch", "POST", {
        issueIdsOrKeys: issues.slice(index, index + 1000).map((issue) => issue.id),
        maxResults: 1000,
        nextPageToken: token,
      });
      for (const log of page.issueChangeLogs) {
        const issue = byId.get(String(log.issueId));
        for (const history of log.changeHistories) {
          if (issue && history.author?.accountId === account) add(history.created, issue, [...new Set(history.items.map((item) => item.field))].join(", "));
        }
      }
      token = page.nextPageToken;
    } while (token);
  }
  return result;
}

/** The user's last view per issue in the range; a later view replaces it, so it serves recent days best. */
async function lastViews(from: string, to: string): Promise<View[]> {
  const views: View[] = [];
  let nextPageToken: string | undefined;
  do {
    const page: { issues: { key: string; fields: { lastViewed: string; summary: string } }[]; nextPageToken?: string } = await jira("/rest/api/3/search/jql", "POST", {
      jql: `lastViewed >= "${from}" AND lastViewed < "${addDays(to, 1)}"`,
      fields: ["lastViewed", "summary"],
      maxResults: 100,
      nextPageToken,
    });
    for (const issue of page.issues) {
      const at = new Date(issue.fields.lastViewed);
      // JQL compares dates in the Jira profile's time zone; the day is the machine's, as for every other source.
      if (localDate(at) < from || localDate(at) > to) continue;
      views.push({ date: localDate(at), time: at.getHours() * 60 + at.getMinutes(), ms: at.getTime(), issue: issue.key, summary: issue.fields.summary });
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return views.sort((a, b) => a.ms - b.ms);
}

async function schedule(from: string, to: string): Promise<Day[]> {
  return (await tempo<{ results: Day[] }>(`/4/user-schedule?from=${from}&to=${to}`)).results;
}

async function booked(account: string, from: string, to: string): Promise<Booked[]> {
  const worklogs: TempoWorklog[] = [];
  let path = `/4/worklogs/user/${account}?from=${from}&to=${to}&limit=1000`;
  for (;;) {
    const page = await tempo<{ results: TempoWorklog[]; metadata: { next?: string } }>(path);
    worklogs.push(...page.results);
    if (!page.metadata.next) break;
    const next = new URL(page.metadata.next);
    path = next.pathname + next.search;
  }
  const keys = worklogs.length ? await issueKeys(worklogs.map((worklog) => worklog.issue.id)) : new Map<number, string>();
  return worklogs.map((worklog) => ({
    date: worklog.startDate,
    start: toMinutes(worklog.startTime ?? "00:00"),
    minutes: Math.round(worklog.timeSpentSeconds / 60),
    issue: keys.get(worklog.issue.id) ?? `#${worklog.issue.id}`,
    issueId: worklog.issue.id,
    description: (worklog.description ?? "").split(/\r?\n/)[0].slice(0, 60),
  }));
}

// --- GitHub ---------------------------------------------------------------

interface HistoryPage {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: Commit[];
}

interface Viewer {
  id: string;
  login: string;
}

async function viewer(): Promise<Viewer> {
  return (await github<{ viewer: Viewer }>("query { viewer { id login } }", {})).viewer;
}

interface Commit {
  oid: string;
  authoredDate: string;
  messageHeadline: string;
  parents: { totalCount: number };
}

const HISTORY = `history(first: 100, after: $after, since: $since, author: { id: $author }) {
  pageInfo { hasNextPage endCursor }
  nodes { oid authoredDate messageHeadline parents { totalCount } }
}`;

const REPOSITORIES_QUERY = `query($login: String!, $after: String) {
  repositoryOwner(login: $login) {
    repositories(first: 100, after: $after, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { name pushedAt }
    }
  }
}`;

const BRANCHES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { ... on Commit { committedDate } } }
    }
  }
}`;

const BRANCHES_PER_REQUEST = 50;

/** One request for the histories of up to `BRANCHES_PER_REQUEST` branches, each an alias. */
function historiesQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  return `query($owner: String!, $name: String!, $after: String, $since: GitTimestamp!, $author: ID!, ${indexes.map((index) => `$b${index}: String!`).join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${indexes.map((index) => `b${index}: ref(qualifiedName: $b${index}) { target { ... on Commit { ${HISTORY} } } }`).join("\n    ")}
  }
}`;
}

const REF_QUERY = `query($owner: String!, $name: String!, $ref: String!, $after: String, $since: GitTimestamp!, $author: ID!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { ... on Commit { ${HISTORY} } } }
  }
}`;

function githubOwners(): string[] {
  return env("GITHUB_OWNERS").split(",").map((value) => value.trim()).filter(Boolean);
}

async function repositories(owner: string, since: string): Promise<string[]> {
  if (owner.includes("/")) return [owner];
  const names: string[] = [];
  let after: string | null = null;
  for (;;) {
    type Page = { repositoryOwner: { repositories: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { name: string; pushedAt: string | null }[] } } | null };
    const data: Page = await github<Page>(REPOSITORIES_QUERY, { login: owner, after });
    if (!data.repositoryOwner) throw new Error(`GitHub owner ${owner} not found.`);
    const page = data.repositoryOwner.repositories;
    for (const repository of page.nodes) {
      if (!repository.pushedAt || repository.pushedAt < since) return names;
      names.push(`${owner}/${repository.name}`);
    }
    if (!page.pageInfo.hasNextPage) return names;
    after = page.pageInfo.endCursor;
  }
}

async function history(repository: string, since: string, author: string): Promise<HistoryPage["nodes"]> {
  const [owner, name] = repository.split("/");
  // A branch whose last commit is older than `since` holds no newer one; reading only the others saves most requests.
  const recent: string[] = [];
  for (let after: string | null = null; ; ) {
    type Page = { repository: { refs: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { name: string; target: { committedDate?: string } }[] } } };
    const data: Page = await github<Page>(BRANCHES_QUERY, { owner, name, after });
    for (const ref of data.repository.refs.nodes) {
      if (!ref.target.committedDate || ref.target.committedDate >= since) recent.push(`refs/heads/${ref.name}`);
    }
    if (!data.repository.refs.pageInfo.hasNextPage) break;
    after = data.repository.refs.pageInfo.endCursor;
  }
  const result: HistoryPage["nodes"] = [];
  for (let start = 0; start < recent.length; start += BRANCHES_PER_REQUEST) {
    const batch = recent.slice(start, start + BRANCHES_PER_REQUEST);
    const branches = Object.fromEntries(batch.map((ref, index) => [`b${index}`, ref]));
    type Page = { repository: Record<string, { target: { history?: HistoryPage } } | null> };
    const data: Page = await github<Page>(historiesQuery(batch.length), { owner, name, after: null, since, author, ...branches });
    for (const [alias, ref] of Object.entries(branches)) {
      // A branch deleted since the listing is null.
      let page = data.repository[alias]?.target.history;
      while (page) {
        result.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) break;
        type More = { repository: { ref: { target: { history: HistoryPage } } | null } };
        const more: More = await github<More>(REF_QUERY, { owner, name, ref, after: page.pageInfo.endCursor, since, author });
        page = more.repository.ref?.target.history;
      }
    }
  }
  return result;
}

/** The viewer's commits authored in the range, each once; needs no Jira data, so it starts with the first requests. */
async function commits(
  from: string,
  to: string,
  viewerRequest: Promise<Viewer>,
  warnings: string[],
  onRepositories: (total: number, skipped: number) => void = () => {},
): Promise<Commit[]> {
  // The history filter `since` compares the committer date; the authored date decides the day.
  const since = new Date(`${from}T00:00:00`).toISOString();
  const viewer = await viewerRequest;
  const owners = githubOwners();
  const queue = (await Promise.all(owners.map((owner) => repositories(owner, since)))).flat();
  const total = queue.length;
  let skipped = 0;
  onRepositories(total, skipped);
  const histories: HistoryPage["nodes"][] = [];
  const worker = async () => {
    for (let repository = queue.shift(); repository; repository = queue.shift()) {
      try {
        histories.push(await history(repository, since, viewer.id));
      } catch (error) {
        onRepositories(total, ++skipped);
        warnings.push(`skipped ${repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const seen = new Set<string>();
  return histories.flat().filter((node) => {
    if (seen.has(node.oid)) return false;
    seen.add(node.oid);
    const date = localDate(new Date(node.authoredDate));
    return date >= from && date <= to;
  });
}

/** Commits as activity, once the Jira project keys are known to find the issue in each subject. */
function commitActivities(commits: Commit[], projects: Set<string>): Activity[] {
  const result: Activity[] = [];
  for (const node of commits) {
    const authored = new Date(node.authoredDate);
    const date = localDate(authored);
    const issue = issueKey(node.messageHeadline, projects);
    const merge = node.parents.totalCount > 1;
    const review = merge && node.messageHeadline.startsWith("Merge pull request");
    if (merge && !review && !issue) continue;
    result.push({
      date,
      time: authored.getHours() * 60 + authored.getMinutes(),
      ms: authored.getTime(),
      issue,
      kind: review ? "review" : merge ? "merge" : "commit",
      text: node.messageHeadline,
    });
  }
  return result;
}

// --- GitHub pull requests -------------------------------------------------

interface PullRequestNode {
  id: string;
  number: number;
  title: string;
  headRefName: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
}

export interface ReviewedPullRequest extends PullRequestNode {
  reviews: {
    totalCount: number;
    nodes: { submittedAt: string | null; state: string; body: string; comments: { totalCount: number; nodes: { createdAt: string; state: string }[] } }[];
  } | null;
}

export interface PullRequestComment {
  createdAt: string;
  updatedAt: string;
  repository: { nameWithOwner: string };
  pullRequest: PullRequestNode | null;
}

/** The viewer's review or comment on a pull request, before the Jira project keys are known. */
export interface PullRequestEvent {
  ms: number;
  kind: "pr-review" | "pr-comment";
  own: boolean;
  pullRequest: { number: number; title: string; branch: string };
}

const PULL_REQUEST = `id number title headRefName author { login } repository { nameWithOwner }`;
const REVIEWS_PER_PULL_REQUEST = 50;
const COMMENTS_PER_REVIEW = 50;
const REVIEWED_QUERY = `query($query: String!, $after: String, $login: String!) {
  search(type: ISSUE, query: $query, first: 25, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      ${PULL_REQUEST}
      reviews(author: $login, last: ${REVIEWS_PER_PULL_REQUEST}) {
        totalCount
        nodes { submittedAt state body comments(first: ${COMMENTS_PER_REVIEW}) { totalCount nodes { createdAt state } } }
      }
    } }
  }
}`;
const PULL_REQUEST_COMMENTS_QUERY = `query($after: String) {
  viewer { issueComments(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt updatedAt repository { nameWithOwner } pullRequest { ${PULL_REQUEST} } }
  } }
}`;
// GitHub's search index can lag behind a pull request's last update; reviews and comments are filtered by time afterwards.
const SEARCH_LEAD_DAYS = 7;
const SEARCH_LIMIT = 1000;

/**
 * The viewer's reviews and pull request comments. Reviews (with their inline comments and thread replies) come from a
 * search per owner, conversation comments from the viewer's comments, newest first. A failure only warns: the draft
 * still has the commits.
 */
async function pullRequests(from: string, to: string, viewerRequest: Promise<Viewer>, warnings: string[]): Promise<PullRequestEvent[]> {
  const { login } = await viewerRequest;
  const owners = githubOwners();
  const since = new Date(`${from}T00:00:00`).toISOString();
  const reviewed = new Map<string, ReviewedPullRequest>();
  for (const owner of owners) {
    const query = `is:pr reviewed-by:@me ${owner.includes("/") ? "repo" : "user"}:${owner} updated:>=${addDays(from, -SEARCH_LEAD_DAYS)}`;
    try {
      for (let after: string | null = null; ; ) {
        type Page = { search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: (ReviewedPullRequest | null)[] } };
        const data: Page | null = await githubPartial<Page>(REVIEWED_QUERY, { query, after, login }, warnings);
        if (!data) break;
        if (!after && data.search.issueCount > SEARCH_LIMIT) warnings.push(`GitHub: ${data.search.issueCount} reviewed pull requests of ${owner}, only the first ${SEARCH_LIMIT} read`);
        for (const node of data.search.nodes) if (node?.id) reviewed.set(node.id, node);
        if (!data.search.pageInfo.hasNextPage) break;
        after = data.search.pageInfo.endCursor;
      }
    } catch (error) {
      warnings.push(`skipped reviews of ${owner}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const comments: PullRequestComment[] = [];
  try {
    for (let after: string | null = null; ; ) {
      type Connection = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: (PullRequestComment | null)[] };
      const data: { viewer: { issueComments: Connection } } | null = await githubPartial(PULL_REQUEST_COMMENTS_QUERY, { after }, warnings);
      if (!data) break;
      const page: Connection = data.viewer.issueComments;
      const nodes = page.nodes.filter((node) => node !== null);
      comments.push(...nodes);
      // Newest update first: a comment created in the range was updated in it or later.
      if (!page.pageInfo.hasNextPage || nodes.some((node) => node.updatedAt < since)) break;
      after = page.pageInfo.endCursor;
    }
  } catch (error) {
    warnings.push(`skipped pull request comments: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const pullRequest of reviewed.values()) {
    const reviews = pullRequest.reviews;
    const oldest = reviews?.nodes[0]?.submittedAt;
    if (reviews && reviews.totalCount > reviews.nodes.length && oldest && oldest >= since) {
      warnings.push(`GitHub: only your last ${REVIEWS_PER_PULL_REQUEST} reviews of ${pullRequest.repository.nameWithOwner}#${pullRequest.number} read`);
    }
    if (reviews?.nodes.some((review) => review.comments.totalCount > review.comments.nodes.length)) {
      warnings.push(`GitHub: only the first ${COMMENTS_PER_REVIEW} comments per review of ${pullRequest.repository.nameWithOwner}#${pullRequest.number} read`);
    }
  }
  return pullRequestEvents([...reviewed.values()], comments, login, owners, from, to);
}

/**
 * Reviews at their submission, comments when they were written (an inline comment while the review was pending). A
 * comment-only review without text is a thread reply, counted by its comment.
 */
export function pullRequestEvents(
  reviewed: ReviewedPullRequest[],
  comments: PullRequestComment[],
  login: string,
  owners: string[],
  from: string,
  to: string,
): PullRequestEvent[] {
  const result: PullRequestEvent[] = [];
  const add = (stamp: string, kind: PullRequestEvent["kind"], pullRequest: PullRequestNode) => {
    const at = new Date(stamp);
    if (localDate(at) < from || localDate(at) > to) return;
    result.push({
      ms: at.getTime(),
      kind,
      own: pullRequest.author?.login === login,
      pullRequest: { number: pullRequest.number, title: pullRequest.title, branch: pullRequest.headRefName },
    });
  };
  for (const pullRequest of new Map(reviewed.map((each) => [each.id, each])).values()) {
    for (const review of pullRequest.reviews?.nodes ?? []) {
      if (!review.submittedAt || review.state === "PENDING") continue;
      if (review.state !== "COMMENTED" || review.body.trim()) add(review.submittedAt, "pr-review", pullRequest);
      for (const comment of review.comments.nodes) if (comment.state === "SUBMITTED") add(comment.createdAt, "pr-comment", pullRequest);
    }
  }
  const scopes = owners.map((owner) => owner.toLowerCase());
  for (const comment of comments) {
    const repository = comment.repository.nameWithOwner.toLowerCase();
    if (!comment.pullRequest || !scopes.some((scope) => scope === repository || scope === repository.split("/")[0])) continue;
    add(comment.createdAt, "pr-comment", comment.pullRequest);
  }
  return result.sort((a, b) => a.ms - b.ms);
}

/** The branch names the issue more reliably than the title; branches are often lowercase or end in "_text". */
export function pullRequestActivities(events: PullRequestEvent[], projects: Set<string>): Activity[] {
  return events.map((event) => {
    const at = new Date(event.ms);
    const { number, title, branch } = event.pullRequest;
    const issue = issueKey(branch.toUpperCase().replace(/[_/]/g, " "), projects) ?? issueKey(title, projects);
    return {
      date: localDate(at),
      time: at.getHours() * 60 + at.getMinutes(),
      ms: event.ms,
      issue,
      kind: event.kind,
      text: `PR #${number} ${title}`,
      ...(event.own ? { own: true } : {}),
    };
  });
}

// --- calendar -------------------------------------------------------------

function property(line: string): Property {
  let quoted = false;
  let index = 0;
  for (; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ":" && !quoted) break;
  }
  const [name, ...params] = line.slice(0, index).split(";");
  return {
    name: name.toUpperCase(),
    params: Object.fromEntries(
      params.map((param) => {
        const [key, ...value] = param.split("=");
        return [key.toUpperCase(), value.join("=").replace(/^"|"$/g, "")];
      }),
    ),
    value: line.slice(index + 1),
  };
}

function find(item: Property[], name: string): Property | undefined {
  return item.find((entry) => entry.name === name);
}

function parseStamp(value: string, zone = ""): Stamp | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: match[4] ? Number(match[4]) * 60 + Number(match[5]) : -1,
    zone: match[6] ? "UTC" : zone,
  };
}

function stampOf(entry: Property | undefined): Stamp | undefined {
  return entry && parseStamp(entry.value, entry.params.TZID);
}

function stampsOf(item: Property[], name: string): Stamp[] {
  return item
    .filter((entry) => entry.name === name)
    .flatMap((entry) => entry.value.split(",").map((value) => parseStamp(value, entry.params.TZID)))
    .filter((stamp) => stamp !== undefined);
}

function parseRule(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(value.split(";").map((part) => part.split("=")).map(([key, rest]) => [key.toUpperCase(), rest]));
}

function nthWeekday(year: number, month: number, byDay: string): string {
  const ordinal = Number(byDay.slice(0, -2) || 1);
  let day = 1 + ((DAY_CODES.indexOf(byDay.slice(-2)) - dayOfWeek(`${year}-${pad(month)}-01`) + 7) % 7);
  if (ordinal > 0) day += (ordinal - 1) * 7;
  else {
    while (day + 7 <= daysInMonth(year, month)) day += 7;
    day += (ordinal + 1) * 7;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function transition(item: Property[]): Transition {
  const start = parseStamp(find(item, "DTSTART")?.value ?? "") ?? { date: "1601-01-01", time: 0, zone: "" };
  const [, sign, hours, minutes] = /^([+-])(\d{2})(\d{2})/.exec(find(item, "TZOFFSETTO")?.value ?? "") ?? ["", "+", "00", "00"];
  const rule = parseRule(find(item, "RRULE")?.value);
  return {
    offset: (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)),
    start,
    month: rule ? Number(rule.BYMONTH ?? start.date.slice(5, 7)) : undefined,
    byDay: rule?.BYDAY,
  };
}

function zoneOffset(transitions: Transition[], stamp: Stamp): number {
  const target = `${stamp.date}T${clock(stamp.time)}`;
  const year = Number(stamp.date.slice(0, 4));
  let best = { key: "", offset: transitions[0].offset };
  for (const { offset, start, month, byDay } of transitions) {
    const days = month
      ? [year - 1, year].map((y) => (byDay ? nthWeekday(y, month, byDay) : `${y}-${pad(month)}-${start.date.slice(8)}`))
      : [start.date];
    for (const day of days) {
      const key = `${day}T${clock(start.time)}`;
      if (key <= target && key > best.key) best = { key, offset };
    }
  }
  return best.offset;
}

function epoch(stamp: Stamp, zones: Map<string, Transition[]>): number | undefined {
  const wall = Date.parse(`${stamp.date}T00:00:00Z`) + stamp.time * 60000;
  if (stamp.zone === "UTC") return wall;
  const transitions = zones.get(stamp.zone);
  if (transitions?.length) return wall - zoneOffset(transitions, stamp) * 60000;
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: stamp.zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const offset = (at: number) => {
      const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, Number(part.value)]));
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - at;
    };
    return wall - offset(wall - offset(wall));
  } catch {
    return undefined;
  }
}

function toLocal(stamp: Stamp, zones: Map<string, Transition[]>): { date: string; start: number } {
  const ms = epoch(stamp, zones);
  if (ms === undefined) return { date: stamp.date, start: stamp.time };
  const local = new Date(ms);
  return { date: localDate(local), start: local.getHours() * 60 + local.getMinutes() };
}

function moment(value: { date: string; start: number }): string {
  return `${value.date}T${clock(value.start)}`;
}

function occurs(rule: Record<string, string>, first: string, day: string): boolean {
  const interval = Number(rule.INTERVAL ?? 1);
  const byDay = rule.BYDAY ? rule.BYDAY.split(",") : [];
  const code = DAY_CODES[dayOfWeek(day)];
  const [year, month, date] = day.split("-").map(Number);
  const [firstYear, firstMonth, firstDate] = first.split("-").map(Number);
  const inMonth = () => {
    if (byDay.length) {
      return byDay.some((entry) => {
        const ordinal = entry.slice(0, -2) || rule.BYSETPOS;
        return entry.slice(-2) === code && (!ordinal || nthWeekday(year, month, ordinal + code) === day);
      });
    }
    if (rule.BYMONTHDAY) {
      return rule.BYMONTHDAY.split(",").map(Number).some((value) => (value > 0 ? value : daysInMonth(year, month) + value + 1) === date);
    }
    return date === firstDate;
  };
  switch (rule.FREQ) {
    case "DAILY":
      return dayDiff(first, day) % interval === 0 && (!byDay.length || byDay.includes(code));
    case "WEEKLY": {
      const weekStart = (value: string) => addDays(value, -((dayOfWeek(value) - DAY_CODES.indexOf(rule.WKST ?? "MO") + 7) % 7));
      const weeks = dayDiff(weekStart(first), weekStart(day)) / 7;
      return weeks % interval === 0 && (byDay.length ? byDay.includes(code) : code === DAY_CODES[dayOfWeek(first)]);
    }
    case "MONTHLY":
      return ((year - firstYear) * 12 + month - firstMonth) % interval === 0 && inMonth();
    case "YEARLY":
      return (
        (year - firstYear) % interval === 0 &&
        (rule.BYMONTH ? rule.BYMONTH.split(",").map(Number).includes(month) : month === firstMonth) &&
        inMonth()
      );
    default:
      return false;
  }
}

function expand(rule: Record<string, string>, start: Stamp, from: string, to: string, zones: Map<string, Transition[]>): string[] {
  const until = rule.UNTIL ? parseStamp(rule.UNTIL, start.zone) : undefined;
  const last = until && (until.time < 0 ? `${until.date}T23:59` : moment(toLocal(until, zones)));
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const days: string[] = [];
  let found = 0;
  let day = count === Infinity && addDays(from, -1) > start.date ? addDays(from, -1) : start.date;
  for (; day <= addDays(to, 1) && found < count; day = addDays(day, 1)) {
    if (day !== start.date && !occurs(rule, start.date, day)) continue;
    found++;
    if (last && moment(toLocal({ ...start, date: day }, zones)) > last) break;
    days.push(day);
  }
  return days;
}

function eventMinutes(item: Property[], start: Stamp, zones: Map<string, Transition[]>): number {
  const end = stampOf(find(item, "DTEND"));
  if (end) {
    const [from, to] = [epoch(start, zones), epoch(end, zones)];
    if (from !== undefined && to !== undefined) return Math.round((to - from) / 60000);
    return dayDiff(start.date, end.date) * 1440 + end.time - start.time;
  }
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(find(item, "DURATION")?.value ?? "");
  if (!match) return 0;
  return Number(match[1] ?? 0) * 10080 + Number(match[2] ?? 0) * 1440 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

function declined(item: Property[], email: string): boolean {
  return item.some(
    (entry) => entry.name === "ATTENDEE" && entry.params.PARTSTAT?.toUpperCase() === "DECLINED" && entry.value.toLowerCase().endsWith(`:${email}`),
  );
}

export function parseCalendar(raw: Buffer, from: string, to: string, email = ""): CalendarEvent[] {
  // Unfold on bytes: a fold may split a multibyte UTF-8 character.
  const text = Buffer.from(raw.toString("latin1").replace(/\r?\n[ \t]/g, ""), "latin1").toString("utf8");
  const zones = new Map<string, Transition[]>();
  const items: Property[][] = [];
  let zone: { id: string; transitions: Transition[] } | undefined;
  let current: Property[] | undefined;
  let nested = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const entry = property(line);
    const kind = entry.value.toUpperCase();
    if (entry.name === "BEGIN" && current) nested++;
    else if (entry.name === "END" && nested) nested--;
    else if (nested) continue;
    else if (entry.name === "BEGIN" && kind === "VTIMEZONE") zone = { id: "", transitions: [] };
    else if (entry.name === "BEGIN" && ["VEVENT", "STANDARD", "DAYLIGHT"].includes(kind)) current = [];
    else if (entry.name === "END" && kind === "VEVENT" && current) {
      items.push(current);
      current = undefined;
    } else if (entry.name === "END" && (kind === "STANDARD" || kind === "DAYLIGHT") && current) {
      zone?.transitions.push(transition(current));
      current = undefined;
    } else if (entry.name === "END" && kind === "VTIMEZONE" && zone) {
      zones.set(zone.id, zone.transitions);
      zone = undefined;
    } else if (current) current.push(entry);
    else if (zone && entry.name === "TZID") zone.id = entry.value;
  }

  const overridden = new Set<string>();
  for (const item of items) {
    const id = stampOf(find(item, "RECURRENCE-ID"));
    if (id) overridden.add(`${find(item, "UID")?.value} ${moment(toLocal(id, zones))}`);
  }

  const events: CalendarEvent[] = [];
  for (const item of items) {
    const start = stampOf(find(item, "DTSTART"));
    if (!start || start.time < 0) continue;
    const title = (find(item, "SUMMARY")?.value ?? "").replace(/\\([\\;,nN])/g, (_, char: string) => (char.toLowerCase() === "n" ? " " : char)).trim();
    const busy = find(item, "X-MICROSOFT-CDO-BUSYSTATUS")?.value.toUpperCase();
    const skipped =
      find(item, "STATUS")?.value.toUpperCase() === "CANCELLED" ||
      find(item, "TRANSP")?.value.toUpperCase() === "TRANSPARENT" ||
      busy === "FREE" ||
      busy === "OOF" ||
      CANCELLED.test(title) ||
      (email !== "" && declined(item, email.toLowerCase()));
    const minutes = eventMinutes(item, start, zones);
    if (skipped || minutes <= 0) continue;
    const tentative = busy === "TENTATIVE" || find(item, "STATUS")?.value.toUpperCase() === "TENTATIVE";
    const uid = find(item, "UID")?.value;
    const series = !find(item, "RECURRENCE-ID");
    const rule = series ? parseRule(find(item, "RRULE")?.value) : undefined;
    const exdates = stampsOf(item, "EXDATE");
    const excludedDays = new Set(exdates.filter((stamp) => stamp.time < 0).map((stamp) => stamp.date));
    const excluded = new Set(exdates.filter((stamp) => stamp.time >= 0).map((stamp) => moment(toLocal(stamp, zones))));
    const occurrences = [
      ...(rule ? expand(rule, start, from, to, zones) : [start.date]).map((date) => ({ ...start, date })),
      ...(series ? stampsOf(item, "RDATE").map((stamp) => (stamp.time < 0 ? { ...start, date: stamp.date } : stamp)) : []),
    ];
    for (const occurrence of occurrences) {
      const local = toLocal(occurrence, zones);
      if (local.date < from || local.date > to) continue;
      if (series && (excludedDays.has(occurrence.date) || excluded.has(moment(local)) || overridden.has(`${uid} ${moment(local)}`))) continue;
      events.push({ ...local, minutes, title, tentative });
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
}

async function calendar(from: string, to: string, warnings: string[]): Promise<CalendarEvent[]> {
  const url = process.env.CALENDAR_ICS_URL;
  if (!url) {
    warnings.push("CALENDAR_ICS_URL is not set, so meetings are missing. See README.md.");
    return [];
  }
  const response = await fetch(url.replace(/^webcal:/i, "https:"));
  if (!response.ok) throw new Error(`Downloading the calendar failed with ${response.status}.`);
  const events = parseCalendar(Buffer.from(await response.arrayBuffer()), from, to, process.env.ATLASSIAN_EMAIL);
  if (events.length >= 3 && events.every((event) => PLACEHOLDER_TITLES.has(event.title.toLowerCase()))) {
    warnings.push('the calendar shows only "busy" placeholders. Publish it with "Can view all details". See README.md.');
  }
  return events;
}

// --- planning -------------------------------------------------------------

function shorten(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

// A change to many issues at once is one action: it counts once, for their common parent, else for the batch issue
// viewed first around it (Tempo names one too), else for the one changed first.
export function collapseBatches(activities: Activity[], views: View[] = []): Activity[] {
  const runs: Activity[][] = [];
  for (const activity of activities.filter((each) => each.kind === "jira").sort((a, b) => a.ms - b.ms)) {
    const run = runs.find((candidate) => candidate[0].text === activity.text && activity.time - candidate.at(-1)!.time <= 1);
    if (run) run.push(activity);
    else runs.push([activity]);
  }
  const result = activities.filter((activity) => activity.kind !== "jira");
  for (const run of runs) {
    const issues = [...new Set(run.map((activity) => activity.issue!))];
    if (issues.length < BATCH_SIZE) {
      result.push(...run);
      continue;
    }
    const families = new Set(run.map((activity) => activity.parent?.key ?? activity.issue!));
    const parent = families.size === 1 ? [...families][0] : undefined;
    const around = views.filter((view) => issues.includes(view.issue) && view.ms > run[0].ms - ACTION_MS && view.ms < run.at(-1)!.ms + ACTION_MS);
    const issue = parent ?? around.toSorted((a, b) => a.ms - b.ms)[0]?.issue ?? issues[0];
    const summary = run.find((activity) => activity.issue === issue)?.summary ?? run.find((activity) => activity.parent?.key === issue)?.parent?.summary;
    result.push({
      date: run[0].date,
      time: run.at(-1)!.time,
      ms: run.at(-1)!.ms,
      issue,
      kind: "jira",
      text: run[0].text,
      summary,
      ...(parent ? {} : { batch: issues }),
    });
  }
  return result;
}

// Only generic descriptions get evidence: the agent rewrites them from it. A Jira-only line carries the issue summary already.
function describe(activities: Activity[]): { description: string; evidence?: string } {
  const commits = activities.filter((activity) => activity.kind === "commit");
  const pulls = activities.filter((activity) => activity.kind !== "commit" && activity.kind !== "jira");
  const subjects = (list: Activity[], strip: boolean) =>
    shorten([...new Set(list.map((each) => (strip ? withoutKey(each.text, each.issue ?? "") : each.text)))].join("; "), 120);
  // A merge names the issue in its branch, so removing the key would mangle it.
  if (commits.length) return { description: DESCRIPTION_COMMIT, evidence: subjects(commits, true) };
  if (pulls.some((pull) => pull.kind === "merge" || pull.own)) return { description: DESCRIPTION_COMMIT, evidence: subjects(pulls, false) };
  if (pulls.length) return { description: DESCRIPTION_REVIEW, evidence: subjects(pulls, false) };
  return { description: activities.find((activity) => activity.summary)?.summary ?? DESCRIPTION_COMMIT };
}

export function planDay(
  day: Day,
  existing: Booked[],
  activities: Activity[],
  meetings: CalendarEvent[],
  projects: Set<string>,
  views: View[] = [],
  now = new Date(),
): { entries: Entry[]; notes: string[] } {
  const entries: Entry[] = [];
  const notes: string[] = [];
  const occupied: [number, number][] = existing.map((entry) => [entry.start, entry.start + entry.minutes]);
  const overlaps = (start: number, end: number) => occupied.some(([from, to]) => from < end && start < to);
  const required = Math.round(day.requiredSeconds / 60);
  const bookedMinutes = existing.reduce((sum, entry) => sum + entry.minutes, 0);

  for (const meeting of meetings) {
    const issue = issueKey(meeting.title, projects);
    const end = meeting.start + meeting.minutes;
    const covered = existing.some((entry) => entry.start < end && meeting.start < entry.start + entry.minutes);
    if (covered || (issue && existing.some((entry) => entry.issue === issue))) continue;
    const overlapping = overlaps(meeting.start, end);
    occupied.push([meeting.start, end]);
    const questions = [
      !issue && "meeting without issue key. Which issue?",
      meeting.tentative && "tentative in the calendar. Did it take place?",
      overlapping && "overlaps another entry. Keep both?",
    ].filter((question) => typeof question === "string");
    entries.push({
      date: day.date,
      start: meeting.start,
      minutes: meeting.minutes,
      issue: issue ?? "?",
      description: issue ? withoutKey(meeting.title, issue) : meeting.title,
      question: questions.join(" ") || undefined,
      meeting: true,
    });
  }

  // Each quarter-hour goes to the issue with the strongest activity in it; activity during a meeting
  // belongs to the meeting.
  const blocked = (slot: number) => overlaps(slot * STEP, (slot + 1) * STEP);
  type Strength = { score: number; last: number; lastMs: number };
  const scores = new Map<number, Map<string, Strength>>();
  const counted = new Set<string>();
  const actionStart = new Map<string, number>();
  for (const activity of activities.toSorted((a, b) => a.ms - b.ms)) {
    const slot = Math.floor(activity.time / STEP);
    const id = `${activity.issue} ${activity.time} ${activity.kind}`;
    if (!activity.issue || blocked(slot) || counted.has(id)) continue;
    counted.add(id);
    if (activity.kind === "jira") {
      const start = actionStart.get(activity.issue);
      if (start !== undefined && activity.ms - start < ACTION_MS) continue;
      actionStart.set(activity.issue, activity.ms);
    }
    const issues = scores.get(slot) ?? new Map<string, Strength>();
    const current = issues.get(activity.issue) ?? { score: 0, last: 0, lastMs: 0 };
    issues.set(activity.issue, { score: current.score + WEIGHT[activity.kind], last: activity.time, lastMs: activity.ms });
    scores.set(slot, issues);
  }
  const owners = new Map<number, string>();
  for (const [slot, issues] of scores) {
    const ranked = [...issues].sort(([keyA, a], [keyB, b]) => b.score - a.score || b.last - a.last || a.lastMs - b.lastMs || keyA.localeCompare(keyB));
    owners.set(slot, ranked[0][0]);
  }
  // Work leads up to the activity that records it, so a short gap goes to the issue after it.
  // Longer gaps stay open: they may be breaks or absences.
  for (const slot of [...owners.keys()].sort((a, b) => a - b)) {
    let free = slot - 1;
    while (free >= 0 && !owners.has(free) && !blocked(free) && slot - 1 - free < MAX_GAP / STEP) free--;
    if (free < 0 || !(owners.has(free) || blocked(free))) continue;
    for (let gap = free + 1; gap < slot; gap++) owners.set(gap, owners.get(slot)!);
  }

  // Opening an issue is work in that quarter-hour and the free ones after it: reading leads into work. It only
  // fills quarter-hours the activity above left open, so it never changes those.
  const current = day.date === localDate(now) ? now.getHours() * 60 + now.getMinutes() : Infinity;
  const bookedIssue = (slot: number) => existing.find((entry) => entry.start <= slot * STEP && slot * STEP < entry.start + entry.minutes)?.issue;
  const opens = new Map<number, Map<string, number>>();
  const anchors: [number, string][] = [];
  // Several issues viewed within a minute are a list opened or closed in one go, not reading.
  const read = views.filter((view) => new Set(views.filter((other) => Math.abs(other.ms - view.ms) < ACTION_MS).map((other) => other.issue)).size < BATCH_SIZE);
  for (const view of read) {
    let slot = Math.floor(view.time / STEP);
    // Opened in the last minutes of a meeting: the work that follows it.
    if (blocked(slot) && !blocked(slot + 1) && (slot + 1) * STEP - view.time <= MEETING_TAIL) slot++;
    if (blocked(slot)) {
      // Opened during a worklog on the same issue: the work went on after it.
      if (bookedIssue(slot) === view.issue) anchors.push([slot, view.issue]);
      continue;
    }
    if ((slot + 1) * STEP > current) continue;
    const issues = opens.get(slot) ?? new Map<string, number>();
    issues.set(view.issue, Math.max(issues.get(view.issue) ?? 0, view.ms));
    opens.set(slot, issues);
  }
  const fromViews = new Set<number>();
  for (const [slot, issues] of opens) {
    if (owners.has(slot)) continue;
    owners.set(slot, [...issues].sort(([keyA, a], [keyB, b]) => b - a || keyA.localeCompare(keyB))[0][0]);
    fromViews.add(slot);
  }
  for (const [slot, issues] of opens) if (issues.has(owners.get(slot)!)) anchors.push([slot, owners.get(slot)!]);
  for (const [slot, issue] of anchors.sort(([a], [b]) => a - b)) {
    let next = slot + 1;
    while (blocked(next) && bookedIssue(next) === issue) next++;
    for (const last = next + MAX_GAP / STEP; next < last && !owners.has(next) && !blocked(next) && (next + 1) * STEP <= current; next++) {
      owners.set(next, issue);
      fromViews.add(next);
    }
  }

  const byIssue = Map.groupBy(activities.filter((activity) => activity.issue), (activity) => activity.issue!);
  const worked: Entry[] = [];
  const onlyViewed = new Set<Entry>();
  for (const slot of [...owners.keys()].sort((a, b) => a - b)) {
    const issue = owners.get(slot)!;
    const previous = worked.at(-1);
    if (previous?.issue === issue && previous.start + previous.minutes === slot * STEP) previous.minutes += STEP;
    else worked.push({ date: day.date, start: slot * STEP, minutes: STEP, issue, ...describe(byIssue.get(issue) ?? []) });
    const entry = worked.at(-1)!;
    if (entry.minutes === STEP && fromViews.has(slot)) onlyViewed.add(entry);
    else if (!fromViews.has(slot)) onlyViewed.delete(entry);
  }
  // Commits or a merge elsewhere in the day do not describe reading the issue.
  for (const entry of onlyViewed) {
    entry.description = views.find((view) => view.issue === entry.issue)?.summary ?? entry.description;
    entry.evidence = undefined;
  }
  entries.push(...worked);

  const placed = new Set([...entries.map((entry) => entry.issue), ...existing.map((entry) => entry.issue)]);
  const unplaced = [...byIssue.keys()].filter((issue) => !placed.has(issue));
  if (unplaced.length) {
    const more = unplaced.length > 10 ? ` and ${unplaced.length - 10} more` : "";
    notes.push(`? also active on ${unplaced.slice(0, 10).join(", ")}${more} (during meetings or in a busier quarter-hour)`);
  }
  const keyless = activities.filter((activity) => !activity.issue);
  if (keyless.length) {
    const pullRequests = new Set(keyless.filter((activity) => activity.kind.startsWith("pr-")).map((activity) => activity.text)).size;
    const commits = keyless.filter((activity) => !activity.kind.startsWith("pr-")).length;
    const counts = [commits && `${commits} commit(s)`, pullRequests && `${pullRequests} pull request(s)`].filter(Boolean).join(", ");
    notes.push(`? ${counts} without issue key: ${shorten([...new Set(keyless.map((activity) => activity.text))].join("; "), 120)}`);
  }
  for (const activity of activities.filter((each) => each.batch && placed.has(each.issue!))) {
    notes.push(`· batch: ${clock(activity.time)} ${activity.issue} for ${activity.text} of ${shorten(activity.batch!.join(", "), 100)}`);
  }
  const spansFromViews: { start: number; end: number; issue: string }[] = [];
  for (const slot of [...fromViews].sort((a, b) => a - b)) {
    const last = spansFromViews.at(-1);
    if (last?.end === slot && last.issue === owners.get(slot)) last.end++;
    else spansFromViews.push({ start: slot, end: slot + 1, issue: owners.get(slot)! });
  }
  if (spansFromViews.length) {
    const text = spansFromViews.map(({ start, end, issue }) => `${clock(start * STEP)}${end - start > 1 ? `–${clock(end * STEP)}` : ""} ${issue}`);
    notes.push(`· viewed: ${text.join(", ")}`);
  }

  const drafted = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  const open = required - bookedMinutes - drafted;
  const spans = [...existing, ...entries].map((entry) => [entry.start, entry.start + entry.minutes]).sort(([a], [b]) => a - b);
  const gaps: string[] = [];
  let end = spans[0]?.[0] ?? 0;
  for (const [start, stop] of spans) {
    if (start - end >= STEP) gaps.push(`${clock(end)}–${clock(start)}`);
    end = Math.max(end, stop);
  }
  if (!entries.length && open > 0) notes.push(`? no activity found, ${duration(open)} open. What was it?`);
  else if (entries.length && open > 0) notes.push(`! ${duration(open)} short of ${duration(required)}${gaps.length ? `; gaps ${gaps.join(", ")}` : ""}. Anything to add?`);
  return { entries: entries.sort((a, b) => a.start - b.start), notes };
}


const NOTE_ORDER = ["?", "!", "·"];

/** Questions, then missing hours, then where the lines come from; each names its line by time or key. */
function dayNotes(entries: Entry[], notes: string[]): string[] {
  const result = entries.filter((entry) => entry.question).map((entry) => `? ${clock(entry.start)} ${entry.issue === "?" ? entry.description : entry.issue}: ${entry.question}`);
  result.push(...notes);
  const meetings = entries.filter((entry) => entry.meeting).map((entry) => `${clock(entry.start)} ${entry.issue}`);
  if (meetings.length) result.push(`· calendar: ${meetings.join(", ")}`);
  const evidence = new Map<string, string>();
  for (const entry of entries) if (entry.evidence && !evidence.has(entry.issue)) evidence.set(entry.issue, entry.evidence);
  for (const [issue, text] of evidence) result.push(`· ${issue}: ${text}`);
  return result.sort((a, b) => NOTE_ORDER.indexOf(a[0]) - NOTE_ORDER.indexOf(b[0]));
}

// --- commands -------------------------------------------------------------

async function draft(input: string, view?: "grid" | "list"): Promise<void> {
  const today = localDate(new Date());
  const [from, requestedTo] = parseRange(input, today);
  const to = requestedTo > today ? today : requestedTo;
  if (from > to) throw new UsageError(`${from} is in the future (today is ${weekday(today)} ${today})`, USAGE_DRAFT, RANGE_HINT);

  const warnings: string[] = [];
  // Steps are the requests until a source is finished; GitHub counts its repositories separately.
  const bar = progress({ Tempo: 2, Jira: 4, Calendar: 1, GitHub: 2 });
  let fetched: [Day[], Booked[], Commit[], PullRequestEvent[], CalendarEvent[], Activity[], Set<string>, View[]];
  try {
    // GitHub and the calendar need nothing from Jira, so they start with the first requests.
    const user = viewer();
    const history = bar.track("GitHub", commits(from, to, user, warnings, (total, skipped) => bar.count("GitHub", total, "repos", skipped)), (found) => `${found.length} commits`);
    const pulls = bar.track("GitHub", pullRequests(from, to, user, warnings), (found) => {
      const reviews = found.filter((event) => event.kind === "pr-review").length;
      return `${reviews} reviews, ${found.length - reviews} comments`;
    });
    const events = bar.track("Calendar", calendar(from, to, warnings), (found) => `${found.length} meetings`);
    // Awaited later; without a handler, a failure during the first requests would make them unhandled rejections.
    for (const early of [user, history, pulls, events]) early.catch(() => {});
    const [account, projects, days] = await Promise.all([bar.track("Jira", accountId()), bar.track("Jira", projectKeys()), bar.track("Tempo", schedule(from, to))]);
    const [existing, code, reviews, meetings, tickets, views] = await Promise.all([
      bar.track("Tempo", booked(account, from, to), (found) => `${found.length} worklogs`),
      history,
      pulls,
      events,
      bar.track("Jira", jiraActivity(account, from, to), (found) => `${found.length} changes`),
      bar.track("Jira", lastViews(from, to), (found) => `${found.length} views`),
    ]);
    fetched = [days, existing, code, reviews, meetings, tickets, projects, views];
  } catch (error) {
    bar.failed();
    throw error;
  }
  bar.done();
  const [days, existing, code, reviews, meetings, tickets, projects, views] = fetched;
  const activities = [...commitActivities(code, projects), ...pullRequestActivities(reviews, projects), ...tickets];

  const planned = days.map((day) => {
    const dayExisting = existing.filter((entry) => entry.date === day.date).sort((a, b) => a.start - b.start);
    const plan = planDay(
      day,
      dayExisting,
      collapseBatches(
        activities.filter((activity) => activity.date === day.date),
        views.filter((view) => view.date === day.date),
      ),
      meetings.filter((meeting) => meeting.date === day.date),
      projects,
      views.filter((view) => view.date === day.date),
    );
    return { day, dayExisting, ...plan };
  });
  show(
    `${from}..${to}`,
    planned.map(({ day, dayExisting, entries, notes }) => ({
      date: day.date,
      required: Math.round(day.requiredSeconds / 60),
      holiday: day.holiday?.name,
      booked: dayExisting,
      entries,
      notes,
    })),
    warnings,
    view,
    "",
    projects,
  );
}

// --- output ---------------------------------------------------------------

interface DayPlan {
  date: string;
  required: number;
  holiday?: string;
  booked: Entry[];
  entries: Entry[];
  notes: string[];
}

type Rgb = [number, number, number];

// Okabe-Ito: distinguishable with color vision deficiencies.
const COLOR: Record<"jira" | "meeting" | "code" | "unknown" | "question" | "done" | "dim" | "faint", Rgb> = {
  jira: [86, 180, 233],
  meeting: [230, 159, 0],
  code: [0, 158, 115],
  unknown: [204, 121, 167],
  question: [213, 94, 0],
  done: [0, 158, 115],
  dim: [150, 150, 150],
  faint: [95, 95, 95],
};

/**
 * A person at a terminal gets color and wrapped lines; agents (which read 2D layouts poorly and pay for every escape
 * code) and pipes get the plain draft. Recent Claude Code runs commands in a PTY, so isTTY alone does not tell.
 */
function agent(): boolean {
  const env = process.env;
  return Boolean(env.AI_AGENT || env.OPENCODE || env.CLAUDECODE || env.CODEX_THREAD_ID || env.CODEX_CI);
}

let linksAllowed = true;

/** Issue keys link to Jira wherever colors are shown; no terminal list, since Windows Terminal often sets no WT_SESSION. */
export function hyperlinks(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ATLASSIAN_SITE) && env.FORCE_HYPERLINK !== "0" && env.TERM_PROGRAM !== "Apple_Terminal";
}

/** The Jira address of a key whose project is in `projects`, for linking keys in free text. */
export function issueUrl(site: string | undefined, projects: Set<string>): (key: string) => string | undefined {
  const base = site?.replace(/\/$/, "");
  return (key) => (base && projects.has(key.slice(0, key.lastIndexOf("-"))) ? `${base}/browse/${key}` : undefined);
}

/** `text` cut into plain pieces and the issue keys `url` knows, each with its address. */
export function keyPieces(text: string, url: (key: string) => string | undefined): { text: string; link?: string }[] {
  const pieces: { text: string; link?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(ISSUE_KEY)) {
    const link = url(match[0]);
    if (!link) continue;
    if (match.index > last) pieces.push({ text: text.slice(last, match.index) });
    pieces.push({ text: match[0], link });
    last = match.index + match[0].length;
  }
  if (last < text.length || !pieces.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

/** Keys of the Jira projects and of every line shown link; "?" and made-up words such as UTF-8 do not. */
function dayLinks(days: DayPlan[], projects: Set<string>): (key: string) => string | undefined {
  const issues = days.flatMap((day) => [...day.booked, ...day.entries]).filter((entry) => entry.issue !== "?");
  return issueUrl(process.env.ATLASSIAN_SITE, new Set([...projects, ...issues.map((entry) => entry.issue.slice(0, entry.issue.lastIndexOf("-")))]));
}

function terminal(): { depth: number; width: number; links: boolean } | undefined {
  const env = process.env;
  // FORCE_COLOR keeps the colors in a pipe (less -R); getColorDepth handles NO_COLOR and FORCE_COLOR levels.
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  if ((!process.stdout.isTTY && !forced) || agent() || env.TERM === "dumb") return undefined;
  const links = linksAllowed && hyperlinks(env);
  const depth = process.stdout.isTTY ? process.stdout.getColorDepth() : ({ "2": 8, "3": 24 } as Record<string, number>)[env.FORCE_COLOR!] ?? 4;
  return { depth, width: process.stdout.columns || 100, links };
}

/** Foreground (38) or background (48) in the terminal's color depth. */
function colorCode(color: Rgb, depth: number, ground: 38 | 48 = 38): string {
  if (depth >= 24) return `${ground};2;${color.join(";")}`;
  const cube = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40)));
  if (depth >= 8) return `${ground};5;${16 + 36 * cube(color[0]) + 6 * cube(color[1]) + cube(color[2])}`;
  // Nearest of the 16 standard colors; a threshold per channel turned gray into black and pink into white.
  const distance = (candidate: Rgb) => candidate.reduce((sum, value, i) => sum + (value - color[i]) ** 2, 0);
  const index = BASIC.reduce((best, candidate, i) => (distance(candidate) < distance(BASIC[best]) ? i : best), 0);
  return String((ground === 48 ? 40 : 30) + (index < 8 ? index : 60 + index - 8));
}

const BASIC: Rgb[] = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];

function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * share + b[i] * (1 - share))) as Rgb;
}

/** Black or white text, whichever contrasts more with the background (WCAG relative luminance). */
function textOn(background: Rgb): Rgb {
  const [r, g, b] = background.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? [17, 17, 17] : [245, 245, 245];
}

// Without a terminal, no escape codes at all. NO_COLOR at a terminal drops colors but keeps bold, as no-color.org asks.
function painter(tty: { depth: number; links: boolean } | undefined) {
  return (text: string, color?: Rgb, options: { bold?: boolean; link?: string } = {}): string => {
    if (!tty) return text;
    const { depth, links } = tty;
    const codes = [options.bold && "1", color && depth > 1 && colorCode(color, depth)].filter(Boolean);
    const body = links && options.link ? `\x1b]8;;${options.link}\x1b\\${text}\x1b]8;;\x1b\\` : text;
    return codes.length ? `\x1b[${codes.join(";")}m${body}\x1b[0m` : body;
  };
}

/** Word wrap by display width; a word longer than a line is split between graphemes. Nothing is cut. */
function wrapWords(text: string, width: number): string[] {
  if (!Number.isFinite(width)) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    let rest = graphemes(word);
    while (textWidth(rest.join("")) > width) {
      if (line) lines.push(line);
      line = "";
      let used = 0;
      let count = 0;
      while (count < rest.length && used + cellWidth(rest[count]) <= width) used += cellWidth(rest[count++]);
      lines.push(rest.slice(0, Math.max(1, count)).join(""));
      rest = rest.slice(Math.max(1, count));
    }
    const piece = rest.join("");
    if (!line) line = piece;
    else if (textWidth(line) + 1 + textWidth(piece) <= width) line += ` ${piece}`;
    else {
      lines.push(line);
      line = piece;
    }
  }
  lines.push(line);
  return lines;
}

/** Colored pieces flowed onto lines of at most `width` cells; continuation lines start with `indent`. */
function flow(pieces: { text: string; painted: string }[], width: number, first: string, indent: string): string[] {
  const lines: string[] = [];
  let line = first;
  let used = textWidth(stripVTControlCharacters(first));
  for (const piece of pieces) {
    const size = textWidth(piece.text);
    if (used + size > width && used > textWidth(stripVTControlCharacters(indent))) {
      lines.push(line.trimEnd());
      line = indent;
      used = textWidth(stripVTControlCharacters(indent));
    }
    line += piece.painted;
    used += size;
  }
  lines.push(line.trimEnd());
  return lines;
}

function kindColor(entry: Entry): Rgb {
  if (entry.issue === "?") return COLOR.unknown;
  if (entry.meeting) return COLOR.meeting;
  return entry.evidence ? COLOR.code : COLOR.jira;
}

const HEADER_LEAD = "# ── ";

/** Cells of a `cells` long rule filled for `done` of `required` minutes; full from the required hours on. */
export function filledCells(done: number, required: number, cells: number): number {
  return required > 0 ? Math.min(cells, Math.round((done / required) * cells)) : 0;
}

/**
 * Plain, every line is a draft line or a comment, so book reads the output as is. At a terminal the same lines get
 * color, and long ones wrap: a work line continues indented without "#", so a copied continuation fails loudly in
 * book instead of booking a shortened description; a "#" line continues as a comment.
 */
/** `# ── Mon 2026-11-02 ━━━━━━──── 4h15m / 7h ──`, shared by the list and book's report. */
function dayHeader(date: string, done: number, required: number, holiday: string | undefined, width: number, tty: ReturnType<typeof terminal>): string {
  const paint = painter(tty);
  const name = `${weekday(date)[0].toUpperCase()}${weekday(date).slice(1)} ${date}`;
  const hours = required ? `${duration(done)} / ${duration(required)}${tty && done >= required ? " ✓" : ""}` : done ? duration(done) : "";
  const amount = holiday ? [holiday, hours].filter(Boolean).join(" · ") : hours;
  const rule = Math.max(2, (Number.isFinite(width) ? width : 72) - 10 - name.length - textWidth(amount));
  // The rule itself shows how much of the day is drafted or booked: a separate bar made the header noisy.
  // Plain output keeps a plain rule, so a file for book stays as it was.
  const filled = tty ? filledCells(done, required, rule) : 0;
  return (
    `${paint(HEADER_LEAD, COLOR.faint)}${paint(name, date === localDate(new Date()) ? COLOR.question : undefined, { bold: true })} ` +
    `${paint("━".repeat(filled), done >= required ? COLOR.done : COLOR.dim)}${paint("─".repeat(rule - filled), COLOR.faint)} ` +
    `${paint(amount, holiday ? COLOR.dim : done >= required ? COLOR.done : undefined, { bold: true })}${paint(" ──", COLOR.faint)}`
  );
}

function printDraft(range: string, days: DayPlan[], warnings: string[], subtitle = "", projects = new Set<string>()): void {
  const tty = terminal();
  const paint = painter(tty);
  const url = dayLinks(days, projects);
  const withKeys = (text: string, color?: Rgb) => keyPieces(text, url).map((piece) => paint(piece.text, color, { link: piece.link })).join("");
  // One right edge for headers and wrapped lines; past about 120 columns lines get hard to follow. Only a real terminal
  // wraps: with FORCE_COLOR in a pipe, wrapped lines would no longer be draft lines.
  const width = tty && process.stdout.isTTY ? Math.min(120, Math.max(40, tty.width - 1)) : Infinity;
  const all = days.flatMap((day) => [...day.booked, ...day.entries]);
  const issueWidth = Math.max(3, ...all.map((entry) => entry.issue.length));
  const durationWidth = Math.max(3, ...all.map((entry) => duration(entry.minutes).length));
  // Every date lines up with the weekday in the day header; book ignores the indent.
  const indent = " ".repeat(HEADER_LEAD.length);
  const bookedPrefix = "#  ✓ ";
  const out: string[] = [];

  const comment = (text: string, mark = "", markColor?: Rgb) => {
    // A mark stands under the ✓ of booked lines.
    const lead = mark ? bookedPrefix.slice(0, bookedPrefix.indexOf("✓")) : "# ";
    const indentWidth = lead.length + (mark ? mark.length + 1 : 0);
    wrapWords(text, Math.max(8, width - indentWidth)).forEach((part, index) => {
      const head = index === 0 ? paint(lead, COLOR.faint) + (mark ? `${paint(mark, markColor, { bold: true })} ` : "") : paint("#".padEnd(indentWidth), COLOR.faint);
      out.push(head + withKeys(part, COLOR.dim));
    });
  };
  const header = (date: string, done: number, required: number, holiday?: string) => out.push(dayHeader(date, done, required, holiday, width, tty));
  const entryLine = (entry: Entry, booked: boolean) => {
    const prefix = booked ? bookedPrefix : indent;
    const head = `${entry.date} ${clock(entry.start)} ${duration(entry.minutes).padStart(durationWidth)}  `;
    const column = prefix.length + head.length + issueWidth + 2;
    const text = booked ? COLOR.dim : undefined;
    const link = entry.issue === "?" ? undefined : url(entry.issue);
    const parts = wrapWords(entry.description, Math.max(8, width - column));
    out.push(
      (booked ? `${paint("#", COLOR.faint)}  ${paint("✓", COLOR.dim, { bold: true })} ` : indent) +
        paint(entry.date, COLOR.faint) +
        ` ${paint(clock(entry.start), text)} ` +
        paint(duration(entry.minutes).padStart(durationWidth), text, { bold: true }) +
        "  " +
        paint(entry.issue, booked ? COLOR.dim : kindColor(entry), { bold: true, link }) +
        " ".repeat(issueWidth - entry.issue.length + 2) +
        paint(parts[0], text),
    );
    for (const part of parts.slice(1)) out.push(" ".repeat(column) + paint(part, text));
  };

  const gap = () => out.push(paint("#", COLOR.faint));
  comment(`Draft ${range}${subtitle}.`);
  gap();
  out.push(`${paint("# ", COLOR.faint)}${paint("Note:", COLOR.dim, { bold: true })} ${paint('Lines without "#" will be booked!', COLOR.dim)}`);
  gap();
  const piece = (text: string, painted = paint(text, COLOR.dim)) => ({ text, painted });
  const legendIndent = paint("#         ", COLOR.faint);
  const marks: [string, Rgb, string][] = [
    ["?", COLOR.question, "needs an answer, "],
    ["!", COLOR.meeting, "hours short, "],
    ["✓", COLOR.dim, "booked, "],
    ["·", COLOR.dim, "where lines come from"],
  ];
  out.push(
    ...flow(
      marks.map(([mark, color, meaning]) => piece(`${mark} ${meaning}`, `${paint(mark, color, { bold: true })} ${paint(meaning, COLOR.dim)}`)),
      width,
      `${paint("# ", COLOR.faint)}${paint("Legend:", COLOR.dim, { bold: true })} `,
      legendIndent,
    ),
  );
  // The key colors only exist with colors; without them that line would explain nothing.
  if (tty && tty.depth > 1) {
    const keys: [string, Rgb][] = [["Jira", COLOR.jira], ["meeting", COLOR.meeting], ["GitHub", COLOR.code], ["? no issue", COLOR.unknown]];
    out[out.length - 1] += paint(",", COLOR.dim);
    out.push(...flow(keys.map(([name, color], index) => piece(`${name}${index < keys.length - 1 ? ", " : ""}`, `${paint(name, color, { bold: true })}${index < keys.length - 1 ? paint(", ", COLOR.dim) : ""}`)), width, legendIndent, legendIndent));
  }
  for (const day of days) {
    if (day.required <= 0 && !day.booked.length && !day.entries.length) {
      if (day.holiday) {
        gap();
        header(day.date, 0, 0, day.holiday);
      }
      continue;
    }
    const done = [...day.booked, ...day.entries].reduce((sum, entry) => sum + entry.minutes, 0);
    gap();
    header(day.date, done, day.required, day.holiday);
    gap();
    const lines = [...day.booked.map((entry) => ({ entry, booked: true })), ...day.entries.map((entry) => ({ entry, booked: false }))];
    for (const { entry, booked } of lines.sort((a, b) => a.entry.start - b.entry.start)) entryLine(entry, booked);
    const notes = dayNotes(day.entries, day.notes);
    if (notes.length) gap();
    for (const note of notes) {
      const mark = note[0];
      comment(note.slice(2), mark, mark === "?" ? COLOR.question : mark === "!" ? COLOR.meeting : COLOR.dim);
    }
  }
  if (warnings.length) out.push(paint("#", COLOR.faint));
  for (const warning of warnings) comment(`warning: ${warning}`);
  // Room around the output at a terminal; a file for book stays without it.
  const room = Number.isFinite(width) ? [""] : [];
  console.log([...room, ...out, ...room].join("\n"));
}

// --- grid -----------------------------------------------------------------

interface Cell {
  ch: string;
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  /** Line on the cell's top edge in the text color: the border to a block right above. */
  overline?: boolean;
  link?: string;
  block?: boolean;
}

interface Item extends Entry {
  booked: boolean;
  row: number;
  end: number;
  lane: number;
  lanes: number;
  span: number;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u;
const ROWS_PER_HOUR = 4;

function graphemes(text: string): string[] {
  return Array.from(SEGMENTER.segment(text), (part) => part.segment);
}

function cellWidth(grapheme: string): number {
  return WIDE.test(grapheme) ? 2 : 1;
}

function textWidth(text: string): number {
  return graphemes(text).reduce((sum, grapheme) => sum + cellWidth(grapheme), 0);
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let result = "";
  let used = 0;
  for (const grapheme of graphemes(text)) {
    if (used + cellWidth(grapheme) > width - 1) break;
    result += grapheme;
    used += cellWidth(grapheme);
  }
  return `${result.trimEnd()}…`;
}

/** `left` and `right` in exactly `width` cells; `left` gets cut first. */
function fitBoth(left: string, right: string, width: number): string {
  const rightWidth = textWidth(right);
  if (!right || rightWidth + 2 > width) return fit(left || right, width);
  const head = fit(left, width - rightWidth - 1);
  return head + " ".repeat(width - textWidth(head) - rightWidth) + right;
}

/** Word wrap into at most `lines` lines; a word too long for a line is cut, overflow ends the last line with "…". */
function wrapFit(text: string, width: number, lines: number): string[] {
  if (width <= 0 || lines <= 0) return [];
  const all: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean).map((each) => fit(each, width))) {
    if (!line) line = word;
    else if (textWidth(line) + 1 + textWidth(word) <= width) line += ` ${word}`;
    else {
      all.push(line);
      line = word;
    }
  }
  if (line) all.push(line);
  if (all.length <= lines) return all;
  const kept = all.slice(0, lines);
  kept[lines - 1] = fit(all.slice(lines - 1).join(" "), width);
  return kept;
}

function sgr(cell: Cell, depth: number): string {
  const codes = [cell.bold && "1"];
  if (depth > 1 && cell.fg) codes.push(colorCode(cell.fg, depth));
  if (depth > 1 && cell.bg) codes.push(colorCode(cell.bg, depth, 48));
  if (cell.overline) codes.push("53");
  return codes.filter(Boolean).join(";");
}

function renderCells(rows: Cell[][], tty: { depth: number; links: boolean } | undefined): string[] {
  return rows.map((row) => {
    let out = "";
    let current = "";
    let link = "";
    for (const cell of row) {
      if (cell.ch === "") continue;
      const code = tty ? sgr(cell, tty.depth) : "";
      if (code !== current) {
        out += code ? `\x1b[0;${code}m` : "\x1b[0m";
        current = code;
      }
      const target = tty?.links ? (cell.link ?? "") : "";
      if (target !== link) {
        out += `\x1b]8;;${target}\x1b\\`;
        link = target;
      }
      out += cell.ch;
    }
    if (link) out += "\x1b]8;;\x1b\\";
    if (current) out += "\x1b[0m";
    return current || link ? out : out.trimEnd();
  });
}

/**
 * Side-by-side lanes for overlapping entries, as FullCalendar and react-big-calendar do: clusters of colliding entries,
 * each in the leftmost free lane, then widened into free lanes to the right. Lanes past `maxLanes` are hidden.
 */
function lanes(entries: { entry: Entry; booked: boolean }[], maxLanes: number): { placed: Item[]; hidden: Item[] } {
  const items: Item[] = entries.map(({ entry, booked }) => {
    const row = Math.floor(entry.start / STEP);
    return { ...entry, booked, row, end: Math.max(row + 1, Math.ceil((entry.start + entry.minutes) / STEP)), lane: 0, lanes: 1, span: 1 };
  });
  items.sort((a, b) => a.row - b.row || b.end - a.end);
  const placed: Item[] = [];
  const hidden: Item[] = [];
  let cluster: Item[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const item of cluster) {
      let lane = ends.findIndex((end) => end <= item.row);
      if (lane < 0) lane = ends.push(0) - 1;
      ends[lane] = item.end;
      item.lane = lane;
    }
    const count = Math.min(ends.length, maxLanes);
    for (const item of cluster) {
      const free = (lane: number) => !cluster.some((other) => other.lane === lane && other.row < item.end && item.row < other.end);
      while (item.lane + item.span < count && free(item.lane + item.span)) item.span++;
      item.lanes = count;
      (item.lane < count ? placed : hidden).push(item);
    }
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length && item.row >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(cluster.length > 1 ? clusterEnd : -1, item.end);
  }
  if (cluster.length) flush();
  return { placed, hidden };
}

/**
 * The week as a time grid for a person at a terminal: a column per day, four rows per hour, each entry a block in its
 * source's color with a darker stripe, booked entries muted with "✓", the one running now orange. The rule under each
 * day fills toward its required hours. Questions and missing hours follow below.
 */
function printGrid(range: string, days: DayPlan[], warnings: string[], subtitle: string, projects: Set<string>): void {
  const tty = terminal();
  const depth = tty?.depth ?? 1;
  const color = depth > 1;
  const paint = painter(tty);
  const url = dayLinks(days, projects);
  const withKeys = (text: string, color?: Rgb) => keyPieces(text, url).map((piece) => paint(piece.text, color, { link: piece.link })).join("");
  const shown = days.filter((day) => day.required > 0 || day.holiday || day.booked.length || day.entries.length);
  const all = shown.flatMap((day) => [...day.booked, ...day.entries]);
  const first = Math.min(8 * 60, ...all.map((entry) => entry.start));
  const last = Math.max(17 * 60, ...all.map((entry) => entry.start + entry.minutes));
  const hours: [number, number] = [Math.floor(first / 60), Math.min(24, Math.ceil(last / 60))];
  const width = tty ? tty.width - 1 : 120;
  const gutter = 6;
  const columnWidth = Math.floor((width - gutter) / Math.max(1, shown.length)) - 1;
  if (!shown.length || columnWidth < 8) {
    printDraft(range, days, warnings, subtitle, projects);
    return;
  }

  const rows: Cell[][] = [];
  const at = (x: number, y: number): Cell => {
    while (rows.length <= y) rows.push(Array.from({ length: gutter + shown.length * (columnWidth + 1) }, () => ({ ch: " " })));
    return rows[y][x];
  };
  const put = (x: number, y: number, ch: string, look: Omit<Cell, "ch"> = {}) => {
    at(x, y);
    rows[y][x] = { ch, ...look };
  };
  const text = (x: number, y: number, value: string, look: Omit<Cell, "ch"> = {}) => {
    for (const grapheme of graphemes(value)) {
      put(x, y, grapheme, look);
      if (cellWidth(grapheme) === 2) put(++x, y, "", look);
      x++;
    }
  };

  const top = 2;
  const today = localDate(new Date());
  const xs = shown.map((_, index) => gutter + index * (columnWidth + 1) + 1);
  const rowCount = (hours[1] - hours[0]) * ROWS_PER_HOUR;
  shown.forEach((day, index) => {
    const done = [...day.booked, ...day.entries].reduce((sum, entry) => sum + entry.minutes, 0);
    const full = done >= day.required;
    const name = `${weekday(day.date)[0].toUpperCase()}${weekday(day.date).slice(1)} ${day.date.slice(8)}`;
    const hours = day.required ? `${duration(done)}/${duration(day.required)}${full ? " ✓" : ""}` : done ? duration(done) : "";
    const amount = day.holiday ? [day.holiday, hours].filter(Boolean).join(" · ") : hours;
    const label = fitBoth(name, amount, columnWidth);
    put(xs[index] - 1, 0, "│", { fg: COLOR.faint });
    text(xs[index], 0, label, { bold: true, fg: day.date === today ? COLOR.question : day.holiday ? COLOR.dim : undefined });
    if (amount && label.endsWith(amount)) text(xs[index] + columnWidth - textWidth(amount), 0, amount, { bold: true, fg: day.holiday ? COLOR.dim : full ? COLOR.done : undefined });
    // The rule under the day fills like the list's header rule.
    const filled = filledCells(done, day.required, columnWidth);
    for (let dx = 0; dx < columnWidth; dx++) put(xs[index] + dx, 1, dx < filled ? "━" : "─", { fg: dx >= filled ? COLOR.faint : full ? COLOR.done : COLOR.dim });
  });
  for (let x = 0; x < rows[0].length; x++) if (!xs.some((start) => x >= start && x < start + columnWidth)) put(x, 1, xs.includes(x + 1) ? "┼" : "─", { fg: COLOR.faint });
  for (let y = 0; y < rowCount; y++) {
    const minute = hours[0] * 60 + (y * 60) / ROWS_PER_HOUR;
    if (minute % 60 === 0) text(0, top + y, clock(minute), { fg: COLOR.dim });
    for (const x of xs) {
      put(x - 1, top + y, "│", { fg: COLOR.faint });
      if (minute % 60 === 0 && y > 0) for (let dx = 0; dx < columnWidth; dx++) put(x + dx, top + y, "┈", { fg: COLOR.faint });
    }
  }

  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const hiddenItems: Item[] = [];
  const blocks: { x: number; y: number; w: number }[] = [];
  shown.forEach((day, index) => {
    const entries = [...day.booked.map((entry) => ({ entry, booked: true })), ...day.entries.map((entry) => ({ entry, booked: false }))];
    const { placed, hidden } = lanes(entries, Math.max(1, Math.floor((columnWidth + 1) / 7)));
    hiddenItems.push(...hidden);
    for (const item of placed) {
      const from = Math.max(item.start, hours[0] * 60);
      const to = Math.min(item.start + item.minutes, hours[1] * 60);
      if (to <= from) {
        hiddenItems.push(item);
        continue;
      }
      const y = top + Math.floor(((from - hours[0] * 60) * ROWS_PER_HOUR) / 60);
      const h = Math.max(1, top + Math.ceil(((to - hours[0] * 60) * ROWS_PER_HOUR) / 60) - y);
      const edge = (lane: number) => Math.floor((lane * (columnWidth + 1)) / item.lanes);
      const x = xs[index] + edge(item.lane);
      const w = edge(item.lane + item.span) - 1 - edge(item.lane);
      // Full source color: dimmed tints measured worse contrast and looked muddy. Booked blocks are muted toward gray,
      // like the gray booked lines of the list. The entry running now takes the color of the now line.
      const running = day.date === today && item.start <= minute && minute < item.start + item.minutes;
      const accent = running ? COLOR.question : kindColor(item);
      const bg = color ? (item.booked && !running ? mix(accent, [128, 128, 128], 0.45) : accent) : undefined;
      const fg = bg ? textOn(bg) : undefined;
      // With 16 colors the darker shade maps back to the block color, so the stripe turns black.
      const stripe: Rgb = !bg ? accent : depth === 4 ? [0, 0, 0] : mix(bg, [0, 0, 0], 0.5);
      for (let dy = 0; dy < h; dy++) {
        put(x, y + dy, "▌", { fg: stripe, bg, block: true });
        // Every cell carries the text color: terminals draw the separator line in it, and empty cells would use the default.
        for (let dx = 1; dx < w; dx++) put(x + dx, y + dy, " ", { fg, bg, block: true });
      }
      // One free cell on the right mirrors the gap the half-width stripe leaves on the left.
      const labelWidth = w - 2;
      const prefix = item.booked ? "✓ " : "";
      const name = `${prefix}${item.issue} ${item.description}`;
      const title: Omit<Cell, "ch"> = { fg, bg, bold: true, block: true };
      if (h === 1) text(x + 1, y, fitBoth(name, duration(item.minutes), labelWidth), title);
      else {
        wrapFit(name, labelWidth, h - 1).forEach((line, line_) => text(x + 1, y + line_, line, title));
        const span = `${clock(item.start)}–${clock(item.start + item.minutes)}`;
        const spent = duration(item.minutes);
        const meta = fitBoth(textWidth(span) + 1 + textWidth(spent) <= labelWidth ? span : "", spent, labelWidth);
        text(x + 1, y + h - 1, meta, { fg: fg && bg ? mix(fg, bg, 0.75) : COLOR.dim, bg, block: true });
      }
      const link = item.issue === "?" ? undefined : url(item.issue);
      if (link) {
        for (let dx = 0; dx < Math.min(item.issue.length, labelWidth - prefix.length); dx++) at(x + 1 + prefix.length + dx, y).link = link;
      }
      blocks.push({ x, y, w });
    }
  });
  for (const { x, y, w } of blocks) {
    for (let dx = 0; dx < w; dx++) if (y > top && at(x + dx, y - 1).block) at(x + dx, y).overline = true;
  }

  const todayIndex = shown.findIndex((day) => day.date === today);
  if (todayIndex >= 0 && minute >= hours[0] * 60 && minute < hours[1] * 60) {
    const row = Math.floor(((minute - hours[0] * 60) * ROWS_PER_HOUR) / 60);
    const rowStart = hours[0] * 60 + (row * 60) / ROWS_PER_HOUR;
    text(0, top + row, clock(rowStart % 60 === 0 ? rowStart : minute), { fg: COLOR.question, bold: true });
    // Blocks keep their text; the one running now is orange instead.
    for (let dx = 0; dx < columnWidth; dx++) if (!at(xs[todayIndex] + dx, top + row).block) put(xs[todayIndex] + dx, top + row, "─", { fg: COLOR.question });
  }

  const out: string[] = [];
  const piece = (text: string, painted = paint(text, COLOR.dim)) => ({ text, painted });
  out.push("", ...flow([piece(`Draft ${range}`, paint(`Draft ${range}`, undefined, { bold: true })), ...subtitle.split(/(?<= )/).map((word) => piece(word))], width, "", "  "), "");
  const legend: [string, Rgb][] = [["Jira", COLOR.jira], ["meeting", COLOR.meeting], ["GitHub", COLOR.code], ["? no issue", COLOR.unknown]];
  out.push(
    ...flow(
      [
        ...legend.map(([name, rgb]) => piece(`▌ ${name}   `, `${paint("▌", rgb)} ${paint(name, COLOR.dim)}   `)),
        piece("✓ booked   "),
        piece("─ now", `${paint("─", COLOR.question)} ${paint("now", COLOR.dim)}`),
      ],
      width,
      "",
      "",
    ),
    "",
  );
  out.push(...renderCells(rows, tty));

  const listed = (item: Entry & { booked?: boolean }) =>
    `  ${paint(`${weekday(item.date)} ${item.date.slice(5)} ${clock(item.start)}–${clock(item.start + item.minutes)}`, COLOR.dim)} ` +
    `${paint(duration(item.minutes).padStart(5), undefined, { bold: true })}  ${paint(item.issue, kindColor(item), { bold: true, link: item.issue === "?" ? undefined : url(item.issue) })}  ${fit(item.description, Math.max(20, width - 40))}`;
  if (hiddenItems.length) {
    out.push("", paint("Not in the grid (outside the hours or too many overlaps):", COLOR.dim));
    for (const item of hiddenItems.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)) out.push(listed(item));
  }
  const open = shown.map((day) => ({ day, notes: dayNotes(day.entries, day.notes).filter((note) => note[0] !== "·") })).filter(({ notes }) => notes.length);
  for (const { day, notes } of open) {
    out.push("", paint(`${weekday(day.date)[0].toUpperCase()}${weekday(day.date).slice(1)} ${day.date}`, day.date === today ? COLOR.question : undefined, { bold: true }));
    for (const note of notes) {
      wrapWords(note.slice(2), Math.max(20, Math.min(width, 120) - 4)).forEach((part, index) => {
        const mark = index ? " " : note[0];
        out.push(`  ${paint(mark, note[0] === "?" ? COLOR.question : COLOR.meeting, { bold: true })} ${withKeys(part, COLOR.dim)}`);
      });
    }
  }
  for (const warning of warnings) out.push(paint(`warning: ${warning}`, COLOR.question));
  out.push("", ...wrapWords("The lines to book: add --list. Agents and pipes get them without it.", width).map((line) => paint(line, COLOR.dim)), "");
  console.log(out.join("\n"));
}

/**
 * The grid for a person at a terminal, the list (the draft lines book reads) otherwise or on request. A redirect gets
 * the list even with FORCE_COLOR or --grid, so "draft > draft.txt" always gives a file book can read.
 */
function show(range: string, days: DayPlan[], warnings: string[], view: "grid" | "list" | undefined, subtitle = "", projects = new Set<string>()): void {
  if (view !== "list" && process.stdout.isTTY && terminal()) printGrid(range, days, warnings, subtitle, projects);
  else printDraft(range, days, warnings, subtitle, projects);
}

// --- progress -------------------------------------------------------------

/** A source being fetched: finished after `steps` requests, `details` filled by them for the summary. */
export interface Source {
  name: string;
  steps: number;
  done: number;
  failed: boolean;
  started?: number;
  details: (string | undefined)[];
  count?: { total: number; unit: string; skipped: number };
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SHOW_WAIT_MS = 3000;

function finished(source: Source): boolean {
  return !source.failed && source.done >= source.steps;
}

/** The live line: spinner, then each source in fixed order, never longer than `columns - 1` (a full row wraps). */
export function statusLine(sources: Source[], now: number, columns: number, frame = 0): string {
  const parts = sources.map((source) => {
    if (source.failed) return { text: `${source.name} ✗`, done: false };
    if (finished(source)) return { text: `${source.name} ✓`, done: true };
    const waited = source.started === undefined ? 0 : now - source.started;
    return { text: `${source.name} …${waited >= SHOW_WAIT_MS ? ` ${Math.floor(waited / 1000)}s` : ""}`, done: false };
  });
  const max = Math.max(columns - 1, 1);
  const line = () => ` ${SPINNER[frame % SPINNER.length]} ${parts.map((part) => part.text).join("  ")}`;
  // Finished sources make room first: what is still running is what the line is for.
  while (line().length > max && parts.some((part) => part.done)) parts.splice(parts.findIndex((part) => part.done), 1);
  const text = line();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The line left on stderr: what each source brought, counts first and the time last. Like the live line it stays below
 * the last column: too wide, each source keeps its first count, then only its name.
 */
export function summaryLine(sources: Source[], seconds: number, columns = Infinity): string {
  const failed = sources.some((source) => source.failed);
  const line = (detail: "all" | "first" | "none") => {
    const parts = sources.map((source) => {
      if (source.failed) return `${source.name} ✗`;
      if (!finished(source)) return `${source.name} …`;
      const count = source.count;
      const repos = count ? (count.skipped ? `${count.total - count.skipped}/${count.total} ${count.unit} (${count.skipped} skipped)` : `${count.total} ${count.unit}`) : undefined;
      const all = [repos, ...source.details].filter(Boolean);
      const details = detail === "all" ? all : detail === "first" ? source.details.filter(Boolean).slice(0, 1) : [];
      return details.length ? `${source.name} ${details.join(", ")}` : detail === "none" ? source.name : `${source.name} ✓`;
    });
    const time = seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    return `${failed ? "✗ Fetch failed:" : "✓"} ${[...parts, time].join(" · ")}`;
  };
  const max = Math.max(columns - 1, 1);
  const text = [line("all"), line("first"), line("none")].find((each) => each.length <= max) ?? line("none");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One updating line on stderr while fetching, replaced by one summary line when done. Only for a person at a
 * terminal; agents, pipes and logs get nothing, and "draft > draft.txt" still shows it since stderr stays.
 */
function progress(steps: Record<string, number>) {
  const active = Boolean(process.stderr.isTTY) && !agent() && process.env.TERM !== "dumb";
  const sources: Source[] = Object.entries(steps).map(([name, count]) => ({ name, steps: count, done: 0, failed: false, details: [] }));
  const find = (name: string) => sources.find((source) => source.name === name)!;
  const started = Date.now();
  const depth = active ? process.stderr.getColorDepth() : 1;
  const markColor = (mark: string) => (mark === "✓" ? COLOR.done : mark === "✗" ? COLOR.question : COLOR.jira);
  const paint = (text: string) =>
    depth > 1 ? text.replace(new RegExp(`[✓✗${SPINNER}]`, "g"), (mark) => `\x1b[${colorCode(markColor(mark), depth)}m${mark}\x1b[0m`) : text;
  let shown = "";
  // A blank line sets the line apart from the command above; the first write opens it.
  const open = () => (shown ? "\r\x1b[2K" : "\n");
  const draw = () => {
    const now = Date.now();
    if (now - started < 500) return;
    const line = statusLine(sources, now, process.stderr.columns || 80, Math.floor((now - started) / 100));
    if (line === shown) return;
    process.stderr.write(`${open()}${paint(line)}`);
    shown = line;
  };
  const timer = active ? setInterval(draw, 100) : undefined;
  // After a failure, main's blank line before the error separates it.
  const finish = (after: string) => {
    if (timer) clearInterval(timer);
    if (active) process.stderr.write(`${open()}${paint(summaryLine(sources, (Date.now() - started) / 1000, process.stderr.columns || 80))}\n${after}`);
  };
  return {
    track<T>(name: string, promise: Promise<T>, describe?: (value: T) => string): Promise<T> {
      const source = find(name);
      source.started ??= Date.now();
      const slot = describe ? source.details.push(undefined) - 1 : -1;
      return promise.then(
        (value) => {
          source.done++;
          if (describe) source.details[slot] = describe(value);
          return value;
        },
        (error: unknown) => {
          source.failed = true;
          throw error;
        },
      );
    },
    count(name: string, total: number, unit: string, skipped = 0): void {
      find(name).count = { total, unit, skipped };
    },
    done: () => finish("\n"),
    failed: () => finish(""),
  };
}

/** A made-up week through the same output, without any API call: shows every kind of line. */
function demo(view?: "grid" | "list"): void {
  // Made-up keys must not link into the real Jira site.
  linksAllowed = false;
  const monday = mondayOf(localDate(new Date()));
  const day = (offset: number) => addDays(monday, offset);
  const entry = (date: string, time: string, minutes: number, issue: string, description: string, extra: Partial<Entry> = {}): Entry => ({
    date,
    start: toMinutes(time),
    minutes,
    issue,
    description,
    ...extra,
  });
  const mon = day(0);
  const tue = day(1);
  const wed = day(2);
  const thu = day(3);
  show(
    `${mon}..${thu}`,
    [
      {
        date: mon,
        required: 420,
        booked: [entry(mon, "08:30", 30, "SHOP-101", "Sprint planning prep")],
        entries: [
          entry(mon, "09:00", 30, "TEAM-1", "Daily standup", { meeting: true }),
          entry(mon, "09:30", 120, "SHOP-142", "Implementation", { evidence: "Validate the checkout address; Show inline errors on the payment form" }),
          entry(mon, "11:30", 45, "SHOP-150", "Checkout: Liefer- und Rechnungsadresse getrennt erfassen, inklusive Prüfung der Postleitzahl und Hinweis bei abweichendem Land"),
          entry(mon, "13:15", 15, "SHOP-151", "Warenkorb: Mengenänderung ohne Neuladen"),
          entry(mon, "13:30", 15, "SHOP-152", "Gutscheincode: Fehlermeldung bei abgelaufenem Code"),
          entry(mon, "13:45", 90, "SHOP-142", "Implementation", { evidence: "Validate the checkout address; Show inline errors on the payment form" }),
          entry(mon, "15:15", 45, "TEAM-2", "Weekly sync", { meeting: true }),
        ],
        notes: [
          "? also active on SHOP-120, SHOP-133, SHOP-134, SHOP-135, SHOP-138, SHOP-141, SHOP-144, SHOP-147, SHOP-149 (during meetings or in a busier quarter-hour)",
          "! 30m short of 7h; gaps 12:15–13:15. Anything to add?",
        ],
      },
      {
        date: tue,
        required: 420,
        booked: [],
        entries: [
          entry(tue, "09:00", 30, "TEAM-1", "Daily standup", { meeting: true }),
          entry(tue, "09:30", 15, "SHOP-93", "Gutscheine im Checkout einlösen"),
          entry(tue, "10:00", 60, "?", "Kundentermin Müller GmbH", { meeting: true, question: "meeting without issue key. Which issue?" }),
          entry(tue, "10:30", 30, "OPS-7", "Release 2.4 deployment", { meeting: true, question: "tentative in the calendar. Did it take place? overlaps another entry. Keep both?" }),
          entry(tue, "13:00", 75, "SHOP-160", "Review", { evidence: "PR #318 Show the delivery date in the cart; Merge pull request #318 from shop/issue/SHOP-160" }),
        ],
        notes: [
          "? 2 commit(s), 1 pull request(s) without issue key: Bump dependencies; Fix typo in README; PR #77 Update the CI",
          "! 3h30m short of 7h; gaps 09:45–10:00, 11:00–13:00. Anything to add?",
          "· batch: 09:41 SHOP-93 for resolution, status of SHOP-90, SHOP-91, SHOP-92, SHOP-93, SHOP-94, SHOP-95, SHOP-96, SHOP-97, SHOP-98",
        ],
      },
      { date: wed, required: 0, holiday: "Feiertag (demo)", booked: [], entries: [], notes: [] },
      {
        date: thu,
        required: 420,
        booked: [],
        entries: [
          entry(thu, "09:00", 30, "TEAM-1", "Daily standup", { meeting: true }),
          entry(thu, "09:30", 180, "SHOP-170", "Implementation", {
            evidence: "Split the order service into read and write paths; Cache shipping rates per region; Retry the payment webhook with backoff",
          }),
          entry(thu, "13:00", 45, "SHOP-171", "Versandkosten je Region im Warenkorb anzeigen"),
        ],
        notes: ["! 2h45m short of 7h. Anything to add?", "· viewed: 13:00–13:45 SHOP-171"],
      },
    ],
    [],
    view,
    " (demo data, nothing was fetched)",
  );
}

interface DraftLine extends Entry {
  line: number;
}

interface Planned extends DraftLine {
  issueId: number;
  duplicate: boolean;
  repeats?: number;
}

export function isDate(date: string): boolean {
  const value = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

export function parseLines(text: string, now: Date, problems: string[]): DraftLine[] {
  const today = localDate(now);
  const entries: DraftLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    // Colors survive a copy from the terminal or FORCE_COLOR in a redirect; they are not part of the line.
    const line = stripVTControlCharacters(raw).trim();
    if (!line || line.startsWith("#")) return;
    const at = `line ${index + 1}`;
    const expected = "Expected YYYY-MM-DD HH:MM <duration> <ISSUE-KEY> <description>.";
    const match = LINE.exec(line);
    if (!match) {
      problems.push(`${at}: cannot read "${line}". ${expected}`);
      return;
    }
    const [, date, start, length, issue, description] = match;
    const [hours, minutes] = start.split(":").map(Number);
    let spent = 0;
    try {
      spent = parseDuration(length);
    } catch {
      problems.push(`${at}: "${length}" is not a duration such as 30m, 1h or 1h30m. ${expected}`);
      return;
    }
    const time = hours <= 23 && minutes <= 59;
    const errors = [
      !isDate(date) && `${date} is not a date`,
      isDate(date) && date > today && `${date} is in the future`,
      !time && `${start} is not a time`,
      spent === 0 && "the duration is 0",
      time && hours * 60 + minutes + spent > 24 * 60 && `${start} plus ${length} runs past midnight`,
      time && date === today && hours * 60 + minutes + spent > now.getHours() * 60 + now.getMinutes() && `${start} plus ${length} ends after now (${clock(now.getHours() * 60 + now.getMinutes())})`,
      !VALID_KEY.test(issue) && (issue === "?" ? "? is not an issue yet; replace it with an issue key" : `"${issue}" is not an issue key such as SHOP-123`),
    ].filter((error) => typeof error === "string");
    for (const error of errors) problems.push(`${at}: ${error}.`);
    if (!errors.length) entries.push({ line: index + 1, date, start: hours * 60 + minutes, minutes: spent, issue, description });
  });
  return entries;
}

function span(entry: Entry): string {
  return `${clock(entry.start)}–${clock(entry.start + entry.minutes)} ${entry.issue}`;
}

/**
 * Every line is checked before anything is booked, so a typo in one line never leaves the draft half booked. Format
 * problems come first and need no network, so they show even offline.
 */
async function check(
  text: string,
): Promise<{ account: string; planned: Planned[]; existing: Booked[]; warnings: string[]; remaining: Map<number, number> }> {
  const problems: string[] = [];
  const entries = parseLines(text, new Date(), problems);
  const abort = () => new Error(`${problems.length} problem(s), nothing was booked:\n${problems.join("\n")}\nFix these lines and run book again.`);
  if (problems.length) throw abort();
  if (!entries.length) return { account: "", planned: [], existing: [], warnings: [], remaining: new Map() };
  requireEnv(BOOK_VARIABLES);
  const account = await accountId();
  const ids = new Map<string, number | undefined>();
  const remaining = new Map<number, number>();
  for (const key of new Set(entries.map((entry) => entry.issue))) {
    const found = await issue(key);
    ids.set(key, found?.id);
    if (found) remaining.set(found.id, found.remainingSeconds);
  }
  for (const entry of entries) {
    if (ids.get(entry.issue) === undefined) problems.push(`line ${entry.line}: ${entry.issue} does not exist in Jira, or you cannot see it.`);
  }
  if (problems.length) throw abort();

  const dates = entries.map((entry) => entry.date).sort();
  const existing = entries.length ? await booked(account, dates[0], dates[dates.length - 1]) : [];
  const warnings: string[] = [];
  const planned: Planned[] = [];
  for (const entry of entries) {
    const id = ids.get(entry.issue)!;
    const same = (other: { issueId: number; date: string; start: number; minutes: number }) =>
      other.issueId === id && other.date === entry.date && other.start === entry.start && other.minutes === entry.minutes;
    const overlaps = (other: Entry) => other.date === entry.date && other.start < entry.start + entry.minutes && entry.start < other.start + other.minutes;
    const repeats = existing.some(same) ? undefined : planned.find((other) => !other.duplicate && same(other))?.line;
    const duplicate = repeats !== undefined || existing.some(same);
    if (!duplicate) {
      for (const other of existing.filter(overlaps)) warnings.push(`line ${entry.line} overlaps booked ${span(other)}.`);
      for (const other of planned.filter((other) => !other.duplicate && overlaps(other))) warnings.push(`line ${entry.line} overlaps line ${other.line} (${span(other)}).`);
    }
    planned.push({ ...entry, issueId: id, duplicate, repeats });
  }
  return { account, planned, existing, warnings, remaining };
}

/**
 * Books the checked lines and reports them in the list's layout: a header per day with its total against the
 * required hours, then one line per worklog with its outcome in front. Lines print as they are posted.
 */
async function book(text: string, dryRun: boolean): Promise<boolean> {
  const { account, planned, existing, warnings, remaining } = await check(text);
  if (!planned.length) {
    console.log("Nothing to book.");
    return true;
  }
  const tty = terminal();
  const paint = painter(tty);
  const width = tty && process.stdout.isTTY ? Math.min(120, Math.max(40, tty.width - 1)) : Infinity;
  const say = (line = "") => console.log(line);
  const gap = () => say(paint("#", COLOR.faint));
  const comment = (text: string, mark = "", markColor?: Rgb) => {
    const lead = mark ? `#   ${mark} ` : "# ";
    wrapWords(text, Math.max(8, width - lead.length)).forEach((part, index) => {
      const head = index ? paint("#".padEnd(lead.length), COLOR.faint) : `${paint(mark ? "#   " : "# ", COLOR.faint)}${mark ? `${paint(mark, markColor, { bold: true })} ` : ""}`;
      say(head + paint(part, COLOR.dim));
    });
  };

  const dates = [...new Set(planned.map((entry) => entry.date))].sort();
  const required = new Map<string, number>();
  try {
    for (const day of await schedule(dates[0], dates[dates.length - 1])) required.set(day.date, Math.round(day.requiredSeconds / 60));
  } catch {
    // Only the headers lose their required hours; booking does not depend on them.
  }
  const range = dates.length > 1 ? `${dates[0]}..${dates[dates.length - 1]}` : dates[0];
  const issueWidth = Math.max(3, ...planned.map((entry) => entry.issue.length));
  const durationWidth = Math.max(3, ...planned.map((entry) => duration(entry.minutes).length));
  const statusWidth = dryRun ? "would book".length : "booked 00000000".length;
  const sum = (entries: Entry[]) => entries.reduce((total, entry) => total + entry.minutes, 0);
  // check found every key in Jira.
  const url = issueUrl(process.env.ATLASSIAN_SITE, new Set(planned.map((entry) => entry.issue.slice(0, entry.issue.lastIndexOf("-")))));

  const line = (entry: Planned, status: string, statusColor: Rgb, note = "") => {
    const muted = statusColor === COLOR.dim;
    const text = muted ? COLOR.dim : undefined;
    const head = `${status.padEnd(statusWidth)}  ${entry.date} ${clock(entry.start)} ${duration(entry.minutes).padStart(durationWidth)}  `;
    const column = head.length + issueWidth + 2;
    const parts = wrapWords(entry.description + (note ? ` (${note})` : ""), Math.max(8, width - column));
    say(
      paint(status.padEnd(statusWidth), statusColor, { bold: !muted }) +
        `  ${paint(entry.date, COLOR.faint)} ${paint(clock(entry.start), text)} ` +
        paint(duration(entry.minutes).padStart(durationWidth), text, { bold: true }) +
        "  " +
        paint(entry.issue, text, { bold: true, link: url(entry.issue) }) +
        " ".repeat(issueWidth - entry.issue.length + 2) +
        paint(parts[0], text),
    );
    for (const part of parts.slice(1)) say(" ".repeat(column) + paint(part, text));
  };

  if (Number.isFinite(width)) say();
  comment(dryRun ? `Dry run ${range}: every line checked, nothing will be booked.` : `Booking ${range} in Tempo.`);
  // Before posting, so an overlap is visible while it can still be stopped.
  if (warnings.length) gap();
  for (const warning of warnings) comment(warning, "!", COLOR.meeting);
  let added = 0;
  let failed = 0;
  for (const date of dates) {
    const lines = planned.filter((entry) => entry.date === date).sort((a, b) => a.start - b.start || a.line - b.line);
    gap();
    say(dayHeader(date, sum(existing.filter((entry) => entry.date === date)) + sum(lines.filter((entry) => !entry.duplicate)), required.get(date) ?? 0, undefined, width, tty));
    gap();
    const failures: string[] = [];
    for (const entry of lines) {
      if (entry.duplicate) {
        line(entry, dryRun ? "would skip" : "skipped", COLOR.dim, entry.repeats ? `repeats line ${entry.repeats}` : "already booked");
        continue;
      }
      if (dryRun) {
        line(entry, "would book", COLOR.done);
        added++;
        continue;
      }
      try {
        const remainingEstimateSeconds = Math.max(0, (remaining.get(entry.issueId) ?? 0) - entry.minutes * 60);
        const worklog = await tempo<{ tempoWorklogId: number }>("/4/worklogs", "POST", {
          authorAccountId: account,
          issueId: entry.issueId,
          startDate: entry.date,
          startTime: `${clock(entry.start)}:00`,
          timeSpentSeconds: entry.minutes * 60,
          remainingEstimateSeconds,
          description: entry.description,
        });
        remaining.set(entry.issueId, remainingEstimateSeconds);
        line(entry, `booked ${worklog.tempoWorklogId}`, COLOR.done);
        added++;
      } catch (error) {
        failed++;
        line(entry, "FAILED", COLOR.question);
        failures.push(`line ${entry.line}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) gap();
    for (const failure of failures) comment(failure, "✗", COLOR.question);
  }
  const skipped = planned.filter((entry) => entry.duplicate).length;
  gap();
  const summary = dryRun ? `Dry run: ${added} to book, ${skipped} skipped. Nothing was booked.` : `${added} booked, ${skipped} skipped, ${failed} failed.`;
  say(`${paint("# ", COLOR.faint)}${paint(summary, failed ? COLOR.question : undefined, { bold: true })}`);
  if (Number.isFinite(width)) say();
  return failed === 0;
}

// --- help -----------------------------------------------------------------

const COMMANDS = ["draft", "book", "demo", "help"];
const FLAGS: Record<string, string[]> = { draft: ["--grid", "--list"], demo: ["--grid", "--list"], book: ["--dry-run"] };

/** The closest option within an edit distance of 2 (or by prefix), for "did you mean"; never run, only suggested. */
export function closest(word: string, options: string[]): string | undefined {
  const distance = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  const text = word.toLowerCase();
  const scored = options.map((option) => ({ option, score: text.length > 1 && option.startsWith(text) ? 0 : distance(text, option) }));
  const best = scored.sort((a, b) => a.score - b.score)[0];
  return best && best.score <= 2 ? best.option : undefined;
}

function helpText(command?: string): string {
  const tty = terminal();
  const paint = painter(tty);
  const heading = (text: string) => paint(text, undefined, { bold: true });
  const name = (text: string) => paint(text, COLOR.code, { bold: true });
  const dim = (text: string) => paint(text, COLOR.dim);
  const today = localDate(new Date());
  const [monday, sunday] = parseRange("week", today);
  const day = `${weekday(today)[0].toUpperCase()}${weekday(today).slice(1)}`;
  const todayLine = `Today is ${paint(`${day} ${today}`, COLOR.question, { bold: true })}: week = kw${isoWeek(today)} = ${monday}..${sunday}.`;
  const ranges = [
    "today (or day), yesterday, week, last-week, kw45, 2026-11-03,",
    "2026-11-02..2026-11-04; also heute, gestern, woche, letzte-woche.",
    todayLine,
    "Days after today are left out.",
  ];

  if (command === "draft") {
    return [
      "",
      heading(USAGE_DRAFT),
      "",
      "Drafts worklogs for <range> from GitHub commits and pull request reviews,",
      "calendar meetings and Jira activity, around what is booked already.",
      dim("Read-only: books nothing."),
      "",
      `  ${heading("<range>")}   ${ranges[0]}`,
      ...ranges.slice(1).map((line) => `            ${line}`),
      `  ${name("--grid")}    week grid (the default at a terminal)`,
      `  ${name("--list")}    the draft lines to book, colored at a terminal`,
      "",
      "Piped, redirected or run by an agent, draft prints the plain draft lines",
      "that book reads. Under each day, # ? lines need an answer, # ! lines name",
      "missing hours, # · lines say where the lines come from.",
      "",
      heading("Examples:"),
      `  node . draft yesterday                 ${dim("look at yesterday")}`,
      `  node . draft week > draft.txt          ${dim("save this week's draft to edit")}`,
      `  node . draft 2026-11-02..2026-11-04    ${dim("a span of days")}`,
      "",
    ].join("\n");
  }
  if (command === "book") {
    return [
      "",
      heading(USAGE_BOOK),
      "",
      `Books draft lines in Tempo. ${paint("WRITES worklogs", COLOR.question, { bold: true })}: use only approved lines.`,
      "Reads <file>, or stdin without it. Lines starting with # are skipped.",
      "",
      `  ${name("--dry-run")}   check every line and show what would be booked; books nothing`,
      "",
      "First every line is checked: format, real date and time, not in the",
      "future, issue exists in Jira, no ? as issue. If one fails, nothing is",
      "booked and each problem is listed with its line number. A line identical",
      "to an existing worklog or an earlier line is skipped, so running book",
      "twice is safe. Overlaps only warn.",
      "",
      `${heading("Line:")}  YYYY-MM-DD HH:MM <duration> <ISSUE-KEY> <description>`,
      "       2026-11-03 09:30 30m TEAM-1 Daily standup",
      "",
      heading("Examples:"),
      `  node . book --dry-run draft.txt           ${dim("check, book nothing")}`,
      `  node . book draft.txt                     ${dim("book every line of draft.txt")}`,
      `  node . draft day | node . book --dry-run  ${dim("draft and check in one go")}`,
      `  node . draft day | node . book            ${dim("draft and book in one go")}`,
      "",
      "Piped from draft, a ? line stops the run like any other problem: answer",
      "the open questions in a file first, then book the file.",
      "",
    ].join("\n");
  }
  if (command === "demo") {
    return [
      "",
      heading(USAGE_DEMO),
      "",
      "Shows a made-up week (Monday to Thursday of this week) in the draft views,",
      `with every kind of line. ${dim("Offline: no API calls, no .env needed.")}`,
      "",
      `  ${name("--grid")}    week grid (the default at a terminal)`,
      `  ${name("--list")}    the draft lines, colored at a terminal`,
      "",
    ].join("\n");
  }

  const variables: [string, boolean, string][] = [
    ...DRAFT_VARIABLES.map((variable): [string, boolean, string] => [variable, true, ""]),
    ["CALENDAR_ICS_URL", false, "optional; without it, drafts have no meetings"],
  ];
  const shownValue = (variable: string) => (["ATLASSIAN_SITE", "GITHUB_OWNERS"].includes(variable) ? (process.env[variable] ?? "") : "");
  const setup = variables.map(([variable, required, note]) => {
    const set = Boolean(process.env[variable]);
    const status = set ? paint("set    ", COLOR.done) : required ? paint("missing", COLOR.question, { bold: true }) : paint("missing", COLOR.meeting);
    return `  ${variable.padEnd(20)} ${status}  ${dim(set ? shownValue(variable) : note)}`.trimEnd();
  });
  return [
    "",
    heading("tempo_timesheet_drafter"),
    "",
    "CLI tool that drafts Tempo worklogs from your GitHub commits, pull request",
    "reviews, calendar and Jira activity, and books the lines you approve.",
    "",
    heading("Usage:"),
    `  node . ${name("draft")} <range> [--grid|--list]  draft worklogs ${dim("(read-only)")}`,
    `  node . ${name("book")} [--dry-run] [<file>]      book draft lines ${paint("(WRITES to Tempo)", COLOR.question, { bold: true })}`,
    `  node . ${name("demo")} [--grid|--list]           made-up week ${dim("(no API calls)")}`,
    `  node . ${name("help")} [<command>]               this help, or help for a command`,
    "",
    heading("Workflow:"),
    `  node . draft yesterday > draft.txt    ${dim("1. draft, then review draft.txt")}`,
    `  node . book --dry-run draft.txt       ${dim("2. check every line, book nothing")}`,
    `  node . book draft.txt                 ${dim("3. book the approved lines")}`,
    "",
    `${heading("Shortcut,")} when nothing is open (no ? lines):`,
    "  node . draft day | node . book --dry-run",
    "  node . draft day | node . book",
    "",
    `${heading("<range>")}  ${ranges[0]}`,
    ...ranges.slice(1).map((line) => `         ${line}`),
    `${heading("<file>")}   draft lines; without it, book reads stdin.`,
    "",
    `${heading("Draft lines:")} lines starting with # are comments, all others are booked.`,
    "  YYYY-MM-DD HH:MM <duration> <ISSUE-KEY> <description>",
    "  2026-11-03 09:30 30m TEAM-1 Daily standup",
    "",
    "At a terminal, draft shows a week grid (--list: the lines to book).",
    "Piped, redirected or run by an agent, it prints the plain lines for book.",
    "",
    `${heading("Setup:")} .env next to this program; README.md explains each variable.`,
    ...setup,
    "",
    `${heading("Exit codes:")} 0 ok, 1 failure or lines rejected by book, 2 usage error.`,
    "",
    `${heading("More:")} node . <command> --help`,
    "",
    `${heading("Hint:")} ${dim('From another directory, replace "." with the directory path.')}`,
    "",
  ].join("\n");
}

// --- main -----------------------------------------------------------------

function parseCommand(command: string, args: string[]): { positionals: string[]; flags: Set<string>; usage: string } {
  const usage = { draft: USAGE_DRAFT, book: USAGE_BOOK, demo: USAGE_DEMO }[command] ?? "";
  const allowed = FLAGS[command] ?? [];
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!allowed.includes(arg)) {
      const guess = closest(arg, allowed);
      const safety = command === "book" ? " Nothing was booked." : "";
      throw new UsageError(`unknown option "${arg}"${guess ? `; did you mean "${guess}"?` : ""}${safety}`, usage, `Run "node . ${command} --help" for details.`);
    }
    flags.add(arg);
  }
  if (flags.has("--grid") && flags.has("--list")) throw new UsageError("--grid and --list exclude each other", usage, `Run "node . ${command} --help" for details.`);
  return { positionals, flags, usage };
}

async function main(): Promise<void> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const [command = "", ...args] = process.argv.slice(2);
  const help = command === "help" || command === "-h" || command === "--help" || args.includes("-h") || args.includes("--help");
  if (!command || help) {
    const topic = command === "help" ? args[0] : COMMANDS.includes(command) ? command : undefined;
    if (topic && !COMMANDS.includes(topic)) {
      const guess = closest(topic, COMMANDS);
      throw new UsageError(`no help for "${topic}"${guess ? `; did you mean "${guess}"?` : ""}`, "node . help [<command>]", `Commands: ${COMMANDS.join(", ")}.`);
    }
    console.log(helpText(topic === "help" ? undefined : topic));
    return;
  }
  if (!COMMANDS.includes(command)) {
    const guess = closest(command, COMMANDS);
    throw new UsageError(
      `unknown command "${command}"${guess ? `; did you mean "${guess}"?` : ""}`,
      guess ? ({ draft: USAGE_DRAFT, book: USAGE_BOOK, demo: USAGE_DEMO }[guess] ?? "node . help") : `commands: ${COMMANDS.join(", ")}`,
      'Run "node . --help" for all commands.',
    );
  }

  const { positionals, flags, usage } = parseCommand(command, args);
  const view = flags.has("--grid") ? "grid" : flags.has("--list") ? "list" : undefined;
  if (command === "demo") {
    if (positionals.length) throw new UsageError(`demo takes only --grid or --list, got "${positionals.join(" ")}"`, usage, 'Run "node . demo --help" for details.');
    demo(view);
    return;
  }
  if (command === "draft") {
    if (!positionals.length) throw new UsageError("draft needs a <range>, e.g. yesterday, week or 2026-11-03", usage, RANGE_HINT);
    // Several words join into one range, so "2026-11-02 .. 2026-11-04" works too.
    const range = positionals.join("");
    parseRange(range, localDate(new Date()));
    requireEnv(DRAFT_VARIABLES);
    await draft(range, view);
    return;
  }
  if (positionals.length > 1) {
    throw new UsageError(`book takes one <file>, got ${positionals.length}: ${positionals.map((each) => `"${each}"`).join(" ")}; nothing was booked`, usage, "To book several: cat a.txt b.txt | node . book --dry-run");
  }
  const file = positionals[0];
  // Reading stdin from an interactive terminal would just wait.
  if (!file && process.stdin.isTTY) {
    throw new UsageError("book needs draft lines from <file> or stdin; nothing was booked", usage, 'example: node . book --dry-run draft.txt\nRun "node . book --help" for details.');
  }
  if (file && !existsSync(file)) throw new Error(`cannot read "${file}": no such file; nothing was booked`);
  if (!(await book(readText(file), flags.has("--dry-run")))) process.exitCode = 1;
}

/** A file or stdin as text; Windows PowerShell 5.1 writes UTF-16 with ">" and Out-File, everything else UTF-8. */
function readText(file?: string): string {
  const bytes = readFileSync(file ?? 0);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8");
}

// Only as the program: the tests import the functions without running it.
if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const person = Boolean(process.stderr.isTTY) && !agent() && process.env.TERM !== "dumb";
    const red = person && process.stderr.getColorDepth() > 1;
    const bold = (text: string) => (person ? `\x1b[1m${text}\x1b[0m` : text);
    // Room around the message at a terminal, as around the help; agents and logs keep it compact.
    if (person) console.error("");
    console.error(`${red ? "\x1b[1;31merror:\x1b[0m" : "error:"} ${message}`);
    if (error instanceof UsageError) {
      console.error(`${bold("usage:")} ${error.usage}`);
      console.error(error.hint);
    }
    if (person) console.error("");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
