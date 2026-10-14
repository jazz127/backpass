# Backpass upstream sync: integration addendum

The sync retains merge commit `731d6808517bbfee64d7606b72f1ff64ed2f2c67` and upstream
`e6a030a550be438e5b81a1ba91e01abc90faad07` as ancestry. Incoming changes add opt-in OMP
collection and observer deduplication, separate-git-directory discovery, and upstream
release metadata. House external-source, trace-only, private-run, credential-route,
SSH, and nested-memory capabilities remain required.

The five content-conflict resolutions combine the following behavior:

| File                      | Integration verdict                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`               | Document upstream OMP collection and shared observers alongside the house evidence and scope rules.                                                                                                     |
| `src/commands/propose.js` | Use current discovery's observer and interaction metadata after house freshness admission; consolidate a filtered ledger view while preserving durable history.                                         |
| `src/discovery/index.js`  | Retain house remote and external discovery paths while adding upstream OMP metadata, ancestor cache dependencies, and observer aliases across synced stores.                                            |
| `src/fold.js`             | Accept upstream observer deduplication for corroboration, harm, and domain votes; preserve native sightings for house nested ownership.                                                                 |
| `src/gap-ledger.js`       | Retain durable house provenance and freshness isolation while resolving upstream shared observers at fold time. Distinct native contributions and incompatible freshness stamps stay separately stored. |

Review identified two integration defects in the last two resolutions. Routing had
used observer identities where attribution requires native transcript identities.
It now carries native sightings through direct and persisted folds, representative
quote selection, root ownership, and proposal routing. A child working only in
`apps/api` can support that file even when its observer parent worked at the root;
related sightings still contribute one vote.

Ledger migration and recording had also combined a child's historical wording with
its newly readable parent's source and content stamps. Recording, normalization,
and consolidation now combine only compatible contributions. Filtering checks the
original native source and stamps; stale wording stays durable without entering the
current model view. Source, external revision, and evidence-route boundaries remain
in force. The unsafe combined storage representation is replaced; no house capability
is retired.

The clean proposal overlap keeps observer-based evidence floors and native-based
ownership as separate maps. No new proposal gate or text classifier is introduced.
Behavioral regressions cover direct fold/proposal routing, persisted parent appearance,
representative quote limits, root ownership across nested passes, and consolidation
across native, content, source, revision, and route differences. These are offline
synthetic checks, with no account-integration claim. The outer executor owns the full
check, final PR conflict report, and house CI.
