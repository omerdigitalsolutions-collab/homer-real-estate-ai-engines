# Concurrency-Safe Lead/Property Distribution Engine

Round-robin assignment of incoming leads and properties to agents, executed **inside a Firestore transaction** so parallel arrivals can't double-book the same agent.

## The race condition

Leads arrive from webhooks, WhatsApp, and Facebook scraping — sometimes in the same millisecond. Without locking, two function invocations both read the same "least recently assigned" agent and both assign to him, breaking fair distribution:

```
t=0ms  Lead A reads agents → picks Yossi (oldest lastLeadAssignedAt)
t=1ms  Lead B reads agents → picks Yossi too   ← stale read
t=2ms  Both write assignedAgentId = Yossi      ← double-booked
```

The fix: the whole read → filter → pick → write cycle runs in `db.runTransaction()`. The winning invocation stamps the agent's `lastLeadAssignedAt`; the losing invocation's transaction detects the conflicting write, retries, and picks the *next* agent. Fairness is guaranteed at the database level (ACID), not by hoping invocations don't overlap.

## Smart filtering

Before the round-robin pick, candidates are filtered by:

- **Availability** — `isAvailableForLeads !== false` (undefined counts as available)
- **Specialization** — `sale` / `rent` / `commercial`; agents with no specializations are generalists and match everything
- **Service areas** — geographic match against the lead's desired cities, using the same normalization-based city matcher as the matchmaking engine

Two strictness modes, configured per agency:

- **`strict`** — if no agent passes the filters, nobody is auto-assigned; an admin alert is created for manual routing
- **`flexible`** — falls back to the full pool of available agents

## Round-robin by timestamp

The eligible agent with the **oldest** `lastLeadAssignedAt` wins (never-assigned agents sort first). Leads and properties track separate timestamps (`lastLeadAssignedAt` / `lastPropertyAssignedAt`), so heavy property weeks don't starve an agent of leads.

## Notification fan-out

After assignment: in-app alert + WhatsApp message to the agent; for Facebook-sourced leads, an email digest to the agency admin as well (trimmed in this repo). Every notification failure is caught and logged — a dead notification channel never rolls back an assignment.

## Performance & data structures

**Time complexity — O(A log A)** where A is the number of agents in the agency. The transaction reads all agent documents into memory (one Firestore batch read, not N individual reads), applies filters in a single O(A) pass, then sorts the eligible subset by `lastLeadAssignedAt` with `Array.prototype.sort()` — O(A log A) worst case. In practice A ≤ ~50 for any agency, so the sort is negligible.

**Transaction read pattern — reads before writes.** Firestore transactions require that all reads precede the first write; violating this causes a hard error. `distributeToAgent()` loads the entire agent array first, computes the winner outside the transaction's write phase, then issues a single `transaction.update()`. This structure also minimises contention: the exclusive lock is held for the shortest possible window.

**Specialization filter — `Set` lookup, O(1) per agent.** The lead's required specialization is converted to a `Set` once before the loop; each agent's `specializations` array is checked with `Set.has()` rather than `Array.includes()`. For generalist agents (empty array) the check short-circuits immediately.

**City matching reuse.** The geographic filter calls the same `isCityMatch()` normalisation from the matchmaking engine — no second implementation. Normalised forms are compared with `String.includes()` (O(n) on city string length, which is bounded at ~20 characters).

**Round-robin sort key.** Agents are sorted by a single `Date` value (`lastLeadAssignedAt ?? new Date(0)`), replacing `null` with epoch-zero so never-assigned agents always sort first. The sort is stable in V8 (Node ≥ 11) so agents with equal timestamps preserve insertion order.

**Write footprint — one document.** Regardless of how many agents were evaluated, the transaction writes exactly one update: the winner's `lastLeadAssignedAt` timestamp. No other agent documents are touched. This minimises write contention when many leads arrive in the same second.
