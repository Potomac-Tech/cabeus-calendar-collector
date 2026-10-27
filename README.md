# Cabeus calendar Launch Library collector

A small, independent GitHub Actions collector for the standalone Cabeus Space Calendar preview. It fetches approved free Launch Library API pages and submits them to the calendar's source-scoped receiver. It contains no calendar database, application administrator key, Slack feedback or Cabeus Terminal code.

The hourly workflow runs at minute 17 UTC on Node 24, with no npm dependencies, standard Linux runners, read-only repository permissions and pinned official actions. It also supports manual dispatch. A five-minute timeout and a concurrency group bound execution. Raw source data is neither committed nor uploaded as an artifact.

The receiver grants at most one short-lived reserved request per source. The runner follows no redirects, never sends the calendar token to Launch Library, and retries an uncertain upload using the same response without refetching the API. The calendar server normalizes the original response with its existing adapter, keeping date precision, source provenance, stable IDs and revisions. Shared quota and Retry-After checks apply before collection. Coverage is bounded and schedules can be delayed.

## Activation

This independent public repository contains only the collector, workflow and this README. Calendar application code and data remain in the standalone project. The following steps describe its configuration and maintenance.

1. Publish these three files on the approved separate repository's default branch.
2. Configure the standalone preview's reviewed receiver with a new source-scoped Cloudflare secret LL2_COLLECTOR_TOKEN and LL2_COLLECTION_MODE=external. This disables the Worker's own LL2 data transport. Leave the calendar administrator key on Cloudflare.
3. Save only the matching source-scoped token as the repository Actions secret CABEUS_LL2_COLLECTOR_TOKEN.
4. Dispatch the workflow and inspect both Launch Library sources and their original date precision in the preview. Verify a later scheduled run before claiming automatic recovery.

The fixed destination is https://cabeus-space-calendar-preview.jake-249.workers.dev. Only ll2-launches and ll2-events are accepted; the token cannot administer the application. Protect and rotate it as an ingestion credential. It does not cryptographically attest a provider response.

## Free operation

Standard hosted runners are free in public repositories. Private repositories use a shared included allowance and may incur overage, so private execution needs a verified no-overage budget. No paid API is needed for this low-rate workflow. GitHub can delay or drop scheduled starts and disables public schedules after 60 days without repository activity. Check source freshness and the Actions page during regular maintenance; do not create meaningless commits to evade that policy.

Official references:

- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Launch Library access](https://thespacedevs.com/llapi)
