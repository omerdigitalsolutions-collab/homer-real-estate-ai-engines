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
