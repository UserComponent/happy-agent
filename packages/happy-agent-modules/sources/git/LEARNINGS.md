# Git learnings

## Internal Git events must not launch worktree scans

Recursive Windows watches also report object packs, lock files and reflogs under `.git`.
Classifying each event launched an unnecessary sandboxed PowerShell/Git command. Those paths
now stay with the dedicated metadata watchers; ordinary source changes still reach Git status.
Direct Git operations and clones explicitly hide their background console windows.

## Every repository has a comparison base

Comparison used to require a merge base with a literal `origin/main`, and an unborn branch had
none on purpose. That left Changes and the sidebar counts empty for every project the agent
creates in a new folder (no commits, no remote), for `master` and other default branches, and
for branches unrelated to origin/main — new projects, exactly where users look first, showed
nothing. The user reversed the earlier decision.

The base is now the first that exists: the merge base with `origin/<default branch>` (from
`detectGitDefaultBranch`), the merge base with the local default branch when the remote has none
(matching how workspaces are cut without a remote), HEAD itself (uncommitted work only), and for
an unborn branch the empty tree, named by `git hash-object -t tree /dev/null` so sha256
repositories work. A remote base still wins whenever it exists, so a moved local main never
replaces it. Comparison is unavailable only when Git itself cannot be read. Because the base can
now come from a local branch or appear later, a snapshot records `baseRef`, and a worktree
without a remote base also rescans on its local default branch and on any `origin` ref.

A typed "why unavailable" field for clients was proposed alongside this and dropped: with these
fallbacks the only cause left is a failed Git read, which a client's "temporarily unavailable"
message already describes correctly, so the protocol did not change.

## Every caller tracks a workspace with the same comparison preferences

A worktree cut from origin/release-v8.8 showed its whole distance from origin/main as changes,
although the workspace recorded release-v8.8 as its base. The workspace API tracked it with that
recorded base, but the Happy session list tracked the same workspace without it. The tracker is
keyed by workspace and replaces itself whenever the entity differs, so the session list's
renewals kept winning and also forced a rescan each time the two alternated.

Whoever builds a tracked entity or asks for a snapshot of a workspace passes the workspace's
recorded `baseRef` and `baseCommit` (and, once it exists, its chosen comparison branch). The
comparison follows the merge base with that branch, so commits that land on the branch later never
count as this workspace's changes. Heuristics that guess a branch are only for folders with no
recorded base.

## A recorded base says where a workspace was cut, not where its branch lives now

Three worktrees were cut at the release-v8.8 tip, so they recorded origin/release-v8.8, and
were then rebased or reset onto main. Their counts showed the whole distance between main and the
release branch (+17k to +34k) instead of their own work. The recorded branch now applies only while
HEAD still contains the recorded `baseCommit` (`git merge-base --is-ancestor`, one Git process per
comparison). Once it does not, the comparison falls through to what the repository records and then
the default branch, without a notice; `baseSource` already says where the branch came from. A
rebase onto a newer tip of the same branch keeps the old commit in history, so the record keeps
applying. A ranking of candidate branches by distance was rejected as a heuristic that costs a walk
per candidate. Asking whether `baseCommit` is on the recorded branch detects nothing, because it
always is.

The base commit is part of the tracked entity, so a snapshot measured or remembered without it is
never reused for a workspace that has one.

## A missing revision is not a missing file

Git's path lookup can say a file does not exist in an object even when that object itself is
missing. Historical reads now verify that the revision names a tree before classifying path
absence. Unknown or unavailable history remains an operational failure; only an absent path
within an existing tree returns `found: false`. Oversized blobs have a typed error so bounded
viewers can explain their limit without parsing Git's human-readable output.

## Idle repositories must cost nothing

Linux had no working-tree watch, so every tracked repository — every workspace the phone knew
about, renewed each minute — got a full scan every thirty seconds: status over the whole tree, a
rename-detecting diff against the merge base, and reads of untracked and binary files. On a server
with many workspaces this showed up as periodic IO storms. Working trees are now watched on every
platform, with Git-ignored directories excluded from the Linux Parcel watch so inotify
spends hundreds of watches per checkout instead of tens of thousands. Polling remains only as the
fallback for a tree that cannot be watched, backs off while nothing changes, and proves "nothing
changed" with a status and a stat of each changed path before it will run a diff.

## Count Git processes, not Git work

On Windows every scan Git command was a sandboxed launch: an ACL refresh, a fresh logon, a new
private desktop, and PowerShell, several seconds each. A workspace that deleted 734
vendored files paid two launches per deleted file on every scan (`cat-file -e` on the base tree,
then `cat-file blob`) and then discarded the bytes, because only binary files show an old side.
One scan took close to an hour, so that workspace never went quiet. It made tens of thousands of
logons a day, which drove lsass handle growth and system-wide lag.

The old sides of deleted and binary files are now looked up in one batched `ls-tree -l` with
literal pathspecs. Only a binary file reads its old bytes, with one `cat-file blob` by object ID.
The old side is fully named by the base and the old path, so a later scan against the same base
reuses it instead of asking Git again. The half-hourly safety check on an idle repository proves
the base with one `merge-base` against the snapshot's base branch, instead of rescanning in full.
When changing scan code, count the Git processes per scan and per idle hour, not only the work
each one does.

Fewer commands still each paid for a logon, so on Windows scans no longer start one sandbox per
command. Each workspace keeps one read-only sandbox worker that runs Git directly with its own
restricted token and job per command, about a tenth of a second each instead of seconds, without
the PowerShell Base64 wrapper. It stops after five idle minutes unless an agent run in its folder
still holds it. The worker and its runner keep
their own working directories outside the workspace, because a live process's working directory
cannot be deleted on Windows and an idle worker would otherwise block archiving the workspace.
Git itself is still sandboxed: never move scans out of the sandbox to make them cheaper, because
repository configuration can run programs.

## The scan worker cap never stops a busy worker

The Windows scan worker cap was a hardcoded 32 that evicted the least recently used worker even
in the middle of a scan. That scan failed, and the next one paid a sandbox logon to restart the
worker. The cap is now configurable (`HAPPY_GIT_SCAN_WORKER_MAX`, 1 to 256, default 32), and
eviction skips workers that are busy, held by an agent run, or followed by the tracker. The count
may briefly exceed the cap and is trimmed as workers become idle.

## "Git changes are unavailable" everywhere can be the sandbox, not Git

On Windows, every workspace at once showing Git changes as unavailable was a sandbox ACL problem:
the sandbox group had been denied the whole user profile, so the read-only scanner could not read
any repository inside it. Check `icacls $env:USERPROFILE` for a `HappySandboxUsers` deny before
debugging Git. Setup now removes such a deny on its own; why it existed and how workspaces outside
the profile avoid it are in
`packages/happy-agent-supervisor/native/windows/EXTERNAL_SANDBOX_IDENTITY.md`.

## A working-tree watch must never be replaced or outlive its folder

Two watcher failures surfaced only in the release gate. On Linux, replacing a folder's Parcel
subscription with a narrower one after `.gitignore` changed left the new subscription registered
but deaf, because both share the backend's cached directory tree; a folder now keeps one
subscription for life and events from newly ignored directories are filtered instead. Native
subscribe and unsubscribe calls are serialized process-wide, because a watch opened while the
backend was tearing down after its last close attached to the dying backend.

On Windows, a stopped daemon left its workspace folder undeletable (`EBUSY`). The watcher had
started a sandboxed `git ls-files` in the folder to learn what to ignore, and a process whose
working directory is a folder keeps it locked on Windows even after its parent exits. Windows
watches recursively in the kernel, so it no longer lists ignored directories at all and keeps
Node's `fs.watch`; everywhere, closing a watch aborts a listing still in flight.

## The home directory is never watched

The daemon starts in the home directory, and the Home project's folder is the home directory, so
live Git tracking armed a recursive Parcel watch on `~`. On macOS, Parcel's FSEvents backend
stats every changed path it reports. Each time another application wrote inside
`~/Library/Containers`, the Photos library, Contacts or Documents, that stat made macOS ask the
user to let Happy access other apps' data, or Photos, Contacts or Documents, and it kept asking
every few seconds while the daemon sat idle. The prompt seemed to come from the bundled Tailcat
process because it appeared just after Tailcat started. The unified log named the daemon as the
accessor, and a bare watch on `~` reproduced it. On Linux the same watch would also spend an
inotify watch on every directory in the home.

A root that is the home directory or one of its ancestors, compared after resolving symlinks, now
never gets a native watch and never runs its ignore listing. Its observers see `watching: false`
and poll, the same as for a folder that cannot be watched. Git status on a home folder still
works.

## A missing workspace must not corrupt the JavaScript runtime

Parcel 2.6 destroys a failed subscription on its worker thread, including releasing JavaScript
references there. Watching a missing directory while other file operations run reproduces a
native crash in Node's later stat callback, with the same freed handle seen in the live daemon.
Bun also crashed during exception handling, so changing JavaScript engines or disabling JIT
did not solve the incident.

macOS and Linux now use Parcel with an exact-version pnpm patch. Its thread-safe-function
finalizer resets callback references on their owning JavaScript thread, covering both failed
subscriptions and backend errors. The native addon is compiled during installation, and both
development and release builds load that compiled file; a source patch must never silently load
an unchanged upstream prebuild. Windows keeps its existing `fs.watch` path for immediate folder
release. The missing-workspace process regression remains unchanged, and native checks also
verify ordinary events, ignored directories, unsubscribe, and callback garbage collection.

Parcel reports canonical event paths. Each subscription resolves its native root and uses that
same root for ignore paths and relative event names, so a caller's symlink alias cannot hide
changes. Missing roots keep the original path and the ordinary subscription retry behavior.

## A branch picker lists refs once, not per keystroke

The comparison-branch picker asks for matching branches as a person types. Each listing is one
read-only `for-each-ref` over `refs/heads` and `refs/remotes`, already sorted newest first and
capped at 2 MiB, through the same scan sandbox as the Git state; it never fetches. The parsed list
answers every query for that folder for five seconds, so a burst of typing filters in memory
instead of starting a Git process per keystroke. It lists every remote's branches rather than only
the compared remote's, because any `<remote>/<branch>` resolves as a comparison base and finding
the primary remote would cost a second process. It leaves the checked-out branch out, because a
branch compared with itself measures nothing, and touches no tracker, snapshot, or event.

## Scan workers deny what agent shells deny

On Windows the deny-read ACL state is kept per sandbox group, and each sandbox setup reconciles the
group to the set it was given, revoking anything else. Agent shells are given the daemon's own
state directory (token, databases) through the compute module's host policy; scan workers were
created without it, so each worker setup revoked that deny (dozens of times a day in the sandbox
log), and while it was revoked a sandboxed command could read the daemon's credentials. Scan
workers now take the same host policy from the compute module. A worker that denies less than the
shell undoes the shell's protection, so never create a sandboxed Git command with a narrower
policy.
