# Story Point Calibration — Your Team's Examples

This file anchors `/story-point` (and the `sprint-sp-audit` skill) against **your
team's own** sized tickets. It ships as a template: the buckets and the sizing
lessons below are generic, the examples are yours to fill in.

**How to use it:** every time someone corrects an estimate, append the ticket to
the matching bucket in the format shown. Real anchors beat any rubric — after
~5 entries per bucket the estimates converge on how this team actually sizes.

Entry format:

```markdown
### <TICKET-KEY> — <title>
- **Type:** Bug | Feature | Chore
- **Layer:** Frontend | Backend | Full-stack | Infra
- **What:** one or two sentences on the actual change (files/systems touched)
- **Why <N>:** what put it at this size — scope, touch points, whether it extends
  an existing pattern or builds something new
- **Lesson:** the transferable rule this example teaches
```

---

## Sizing principles that hold across teams

These came out of repeated over-estimation corrections and are worth keeping
regardless of domain:

- **Investigation effort does not inflate points — only fix effort does.** A bug
  that took two days to locate and 30 lines to fix is still small.
- **Multiple symptoms ≠ multiple points.** Ask "how much code changes?", not
  "how many bullet points does the description have?"
- **Extending an existing pattern is cheaper than building a new one.** If most
  of the infrastructure exists and the new work is routing/wiring, size down.
- **Take "most of the structure is already there" seriously** when the requester
  says it — that is the most common cause of over-estimation.
- **QA/testing effort is not story points.** Size the dev work.
- **Between two sizes on a known pattern, lean lower.**

---

## 0.5 Points

_(Add your first example — typically a one-file, one-behavior change: a redirect,
a conditional, a config value.)_

---

## 1 Point

_(Add your first example — typically a single contained fix, a couple of files,
no contract or schema change.)_

---

## 2 Points

_(Add your first example — typically a multi-file change coordinating several
small edits inside one existing flow.)_

---

## 3 Points

_(Add your first example — typically a feature that extends existing patterns: a
new field end-to-end, a new route on established plumbing.)_

---

## 5 Points

_(Add your first example — typically several integration points: migration plus
endpoints plus computation, still building on existing logic.)_

---

## 8 Points

_(Add your first example — typically new-subsystem work, or a change that
rewrites rather than extends existing logic.)_

---

## 13 Points

_(Add your first example — typically work that should have been split. If you are
reaching for 13, first ask whether it decomposes.)_
