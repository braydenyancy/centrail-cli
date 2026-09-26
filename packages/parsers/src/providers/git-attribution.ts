// Pure git-attribution logic shared by the CLI. No I/O, no child_process —
// the CLI's git.ts shells out and feeds the raw `git log` text in here, so all
// the tricky parsing/matching is unit-testable without a real repo.

const RECORD_SEP = "\x1e";
const UNIT_SEP = "\x1f";

export type RepoCommit = {
  sha: string;
  committedAt: Date;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  authorEmail?: string; // lowercased; present when the log format carried %ae
};

export type AttributionEvent = {
  externalId: string;
  occurredAt: Date;
};

export type EventAttribution = {
  externalId: string;
  sha: string;
  committedAt: Date;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
};

// Parses `git log --numstat --pretty=format:%x1e%H%x1f%cI[%x1f%ae]`. Each record
// begins with \x1e, header is `<sha>\x1f<iso-date>[\x1f<author email>]`, then numstat lines
// `<added>\t<deleted>\t<path>`. Binary files emit `-` for the counts.
export function parseGitLogNumstat(text: string): RepoCommit[] {
  const commits: RepoCommit[] = [];
  for (const record of text.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [sha, iso, email] = lines[0].split(UNIT_SEP);
    if (!sha || !iso) continue;
    const authorEmail = email?.trim() ? email.trim().toLowerCase() : undefined;
    const committedAt = new Date(iso);
    if (Number.isNaN(committedAt.getTime())) continue;

    let linesAdded = 0;
    let linesDeleted = 0;
    let filesChanged = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [addedRaw, deletedRaw] = line.split("\t");
      filesChanged++;
      linesAdded += addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0;
      linesDeleted += deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10) || 0;
    }
    commits.push({ sha, committedAt, linesAdded, linesDeleted, filesChanged, ...(authorEmail ? { authorEmail } : {}) });
  }
  return commits;
}

// Attributes each event to the EARLIEST commit at or after it:
//   prev_commit.committedAt < event.occurredAt <= commit.committedAt
// Events newer than the last commit are uncommitted/WIP and returned as no
// attribution (omitted). Commits may arrive in any order; we sort ascending,
// and two commits at the same second tie-break on sha, so the CLI, the
// server (which runs this same function over rows Postgres returns in no
// promised order) and every re-run pick the same commit.
export function matchEventsToCommits(
  events: AttributionEvent[],
  commits: RepoCommit[],
): EventAttribution[] {
  if (commits.length === 0) return [];
  const sorted = [...commits].sort(
    (a, b) => a.committedAt.getTime() - b.committedAt.getTime() || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0),
  );

  const out: EventAttribution[] = [];
  for (const ev of events) {
    const t = ev.occurredAt.getTime();
    // First commit whose committedAt >= event time.
    const commit = sorted.find((c) => c.committedAt.getTime() >= t);
    if (!commit) continue; // newer than HEAD -> WIP
    out.push({
      externalId: ev.externalId,
      sha: commit.sha,
      committedAt: commit.committedAt,
      linesAdded: commit.linesAdded,
      linesDeleted: commit.linesDeleted,
      filesChanged: commit.filesChanged,
    });
  }
  return out;
}
