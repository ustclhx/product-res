# Browser acceptance findings

## Harness

`web/playwright.config.ts` starts an isolated FastAPI process on `127.0.0.1:8001`
with `PRODUCT_RES_DB` pointing at a per-run SQLite file, and a Vite process on
`127.0.0.1:5174` with `VITE_API_TARGET=http://127.0.0.1:8001`. The suite launches
the installed Google Chrome binary. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can
override that path on another host. Traces and failure screenshots are retained;
video is disabled so the suite does not require a Playwright ffmpeg download.

Run from `web/`:

```sh
npm run test:e2e
```

The environment must permit binding the two loopback ports and launching Chrome.

## Passing browser coverage

The final combined run on 2026-09-20 completed with exit code 0: two tests passed
in 29.9 seconds. The six-combination test took 17.5 seconds and the branch test
took 10.3 seconds.

The first test uses the browser to create Amazon, eBay, and DTC projects with
channel, market, direction, goal, constraints, analyst, and decision owner, then
uses the decision-owner role to confirm each channel template. For every channel,
the browser adds one fixture-discovery candidate and one CSV candidate. All six
candidates then pass through these browser actions:

- open the evaluation stage, save a new human evaluation revision, and submit it;
- switch to the decision owner and approve the frozen evaluation;
- open result follow-up, enter a recorded result, open comparison, and save a review.

The second test creates QUOTE, SAMPLE, and TEST tasks through the browser and
executes `TODO -> IN_PROGRESS -> BLOCKED -> IN_PROGRESS -> DONE` for each, including
reasons, actual results, and checked evidence references. It then records the owner
validation conclusion, result, comparison, review, and a feedback proposal. The owner
confirms the proposal and follows its link to create a new project with the revised
rules. API assertions verify both the new rules and unchanged original criteria and
approval snapshots.

The RETURN branch now uses the browser for the entire corrective sequence: return
with questions, append replacement evidence, rerun screening, run the simulated
organizer, copy its draft, save a new evaluation, resubmit, and approve. This caught
and now guards against stale citations remaining in an AI draft after evidence is
superseded. Manual screening restoration and WATCH with a reasoned reopen also pass.

## API fixture boundary

API calls prepare deterministic branch projects, repeated initial MOQ and cost
evidence, and initial screening/evaluation snapshots. For the six repeated channel
combinations, an API command advances the approved candidate to result follow-up;
the branch test separately exercises that conclusion through the UI. API reads
assert persistence and immutable history. These setup calls are not counted as UI
coverage. Task creation, corrective evidence, re-evaluation, and next-round project
creation are now browser actions.

## Manual interface checks

The supervisor checked the actual local preview at 1200×850 and 390×844, including
queue navigation, owner approval, and task entry. Keyboard Enter opens the project
form, Tab reaches its first input, and empty submission focuses the required project
name. Loading, retry, empty, sample, and simulated-assistant states are explicit.
The prototype has not undergone a comprehensive accessibility audit.

## Verification

The E2E-owned files also pass:

```sh
npx eslint e2e/workflow.spec.ts playwright.config.ts
npm run build
npm run test:e2e -- --list
npm run test:e2e
```

The final full suite reported `2 passed (29.9s)`. The only server-side output was
the existing Node warning that `NO_COLOR` is ignored when `FORCE_COLOR` is set;
there were no Vite compilation errors, browser assertion failures, in the successful run. The suite does not separately assert every browser console message.
