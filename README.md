# Delegated Routing + Pubsub Routing CID Repro

This repro spins up:
- a local delegated routing HTTP server that only serves `/routing/v1/providers/*`
- a provider Helia node that subscribes to a pubsub topic
- a resolver Helia node configured like `plebbit-js` (delegated routers only, no `/ipns` endpoints)

The resolver attempts to publish/subscribe over pubsub. It should discover providers by querying the delegated router for the pubsub routing CID, then dial those peers. The bug is that no provider lookup happens, so no peer connections are made.

## Setup

```bash
npm install
```

## Run

```bash
npm run start
```

## What to look for

- No `/routing/v1/providers/*` requests are made (provider query count stays 0).
- The resolver shows `connections after pubsub attempt: 0`.

## Notes

- The delegated router keeps provider announcements for 24 hours (in-memory TTL).
- The router intentionally does not implement `/ipns` endpoints, only `/providers`.
- The router binds a random high port by default; set `DELEGATED_ROUTER_PORT` to override.
