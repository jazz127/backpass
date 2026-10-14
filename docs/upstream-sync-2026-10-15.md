# Backpass upstream sync: integration addendum

The sync retains merge commit `731d6808517bbfee64d7606b72f1ff64ed2f2c67` and upstream
`e6a030a550be438e5b81a1ba91e01abc90faad07` as ancestry. Incoming changes add opt-in OMP
collection and observer deduplication, separate-git-directory discovery, and upstream
release metadata. House external-source, trace-only, private-run, credential-route,
SSH, and nested-memory capabilities remain required.

The five content-conflict resolutions combine the following behavior:

| File                      | Integration verdict                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`               | Document upstream OMP collection and shared observers alongside the house evidence and scope rules.                                                                                                                  |
| `src/commands/propose.js` | Use current discovery's interaction metadata after house freshness admission; resolve current observers in the filtered view before consolidation, preserving durable history.                                       |
| `src/discovery/index.js`  | Retain house remote and external discovery paths while adding upstream OMP metadata, ancestor cache dependencies, and observer aliases across synced stores.                                                         |
| `src/fold.js`             | Accept upstream observer deduplication for corroboration, harm, domain votes, and skill citations; retain eligible native projects, maximum risk, and nested ownership.                                              |
| `src/gap-ledger.js`       | Retain durable house provenance and freshness isolation while resolving current upstream shared observers in filtered views. Distinct native contributions and incompatible freshness stamps stay separately stored. |

Native transcript identities drive direct and persisted ownership, representative
quotes, root ownership, and proposal routing. A child working only in `apps/api` can
support that file even when its observer parent worked at the root. Related native
contributions retain their individual projects and coverage status: coverage in one
project cannot suppress an uncovered contribution in another. Session, domain, and
skill-citation counters deduplicate observers after eligibility; eligible projects and
maximum recurrence risk retain every native contribution. Representative quotes carry
both observer and project witnesses through the proposal floors. Instruction and gap
quotes use the same bounded selection rule, scaled to the configured evidence and
project floors. Synthesis and report rendering emit that selected set without a second
truncation, so an independent witness cannot disappear between storage and the prompt.

Ledger migration and recording had also combined a child's historical wording with
its newly readable parent's source and content stamps. Recording, normalization,
and consolidation now combine only compatible contributions and retain their maximum
recurrence risk with the same reducer used by direct folding. Filtering checks the
original native source and stamps; stale wording stays durable without entering the
current model view. Source, external revision, and evidence-route boundaries remain
in force. The unsafe combined storage representation is replaced; no house capability
is retired.

The filtered ledger view resolves current observer identities before consolidation,
including when a parent header disappears and later returns while a child's analysis
is stale. This changes only the view's observer attribution; durable source identities,
content digests, revisions, evidence keys, and first-seen times remain intact. Analysis,
consolidation, and fold share the filtered-view boundary, while direct folds still
resolve supplied observations against current records.

The clean proposal overlap keeps observer-based evidence floors and native-based
ownership as separate maps. No new proposal gate or text classifier is introduced.
Remote-discovery, analysis-reuse, and interaction regressions assert individual native
provenance and a single related observer vote instead of one storage row per observer.
Behavioral regressions also cover project eligibility in both coverage directions,
contribution order, maximum risk, project-floor proposal acceptance, quote limits,
root ownership across nested passes, and parent-header restoration before consolidation.
Emitted instruction and gap evidence is fed into the real proposal gates at default and
higher evidence/project floors. Persisted recording, normalization, and consolidation
regressions cover high/low ordering and exclude stale high-risk contributions.
These are offline synthetic checks, with no account-integration claim. The outer
executor owns the full check, final PR conflict report, and house CI.
