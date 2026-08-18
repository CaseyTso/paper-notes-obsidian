# Browser Connector contract matrix (V1)

Every row is pinned by a failing-before/restored test; see the reverse
checks in the handoff report.

| Invariant | Enforcement | Test |
|---|---|---|
| Loopback only (`127.0.0.1:27124`) | `CaptureBridge` binds `127.0.0.1`; `CAPTURE_URL` loopback | `capture-bridge.test.ts` |
| Exact Host (DNS-rebinding safe) | strict `Host === 127.0.0.1:<port>` | `rejects bad Host` |
| Exact route `/v1/capture`, method `POST` | path + method checks | `rejects wrong route/method` |
| JSON content type + body cap ≤256 KiB | content-type + capped body reader | `rejects non-JSON / oversized` |
| Required connector version header | `X-Paper-Notes-Connector-Version: 1` on mutation | `rejects missing or wrong connector version header` |
| Schema/field allowlist | shared `protocol.ts` + core `web_capture.py` | protocol tests + `test_web_capture.py` |
| No `Access-Control-Allow-Origin: *` | only a `chrome-extension://` origin is echoed | `preflight only echoes a chrome-extension origin` |
| Web evidence is never `confirmed` | `item create --web-capture` + `web_*` sources | `test_web_capture_create.py` |
| Official source outranks web | `SOURCE_PRIORITY` places `web_*` after crossref/pubmed/arxiv | `test_authoritative_source_wins_over_web` |
| Web-only complete record still needs review | `merge_records` requires a trusted/user source | `test_web_only_complete_record_still_needs_confirmation` |
| Confirmation token binds capture/action/target | `_verify_web_capture_token` under the lock | `test_stale_token_conflict_zero_write` |
| Idempotent `capture_id` reuse | bridge idempotency cache + strong-ID/fuzzy dedup | `rejects capture_id reuse` / retry tests |
| Pending review is memory-only | `WebCaptureActions.reviewStore` + bridge clear on stop | `clears idempotency on stop` |
| No cookies/HTML/body/tags transmitted | extraction allowlist + body cap | `extract.test.ts` (`does not transmit surrounding body text`) |
| Popup uses `textContent`, never `innerHTML` | popup render helper | source review (no automated DOM gate) |
