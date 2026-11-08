<!-- Resume bullet templates (D-15). node tools/resume-claims.mjs renders them into bench/resume-bullets.md. Every
figure comes from an approved claim in bench/claims.json through a placeholder: {{claim:<id>}} (first display.value),
{{claim:<id>#spread}}, {{claim:<id>#n}} and {{claim:<id>#environment}}. A template that names a proposed, retired or
unknown claim stops the tool. Workload sizes (a million keys, sixteen clients) are written in words: they describe the
setup, not a result. Test-count claims carry no environment field, so their environments are named in text. These comments are not copied into the output. -->
# Resume bullets

## Rate Limiter Library

- Built a thread-safe C++20 rate limiter with lock-free lookups over a sharded token-bucket table, using {{claim:rl.memory.k1000000.short.ubuntu-wsl2}} heap bytes per key at a million short keys (heap-accounting allocator, {{claim:rl.memory.k1000000.short.ubuntu-wsl2#environment}}, median of {{claim:rl.memory.k1000000.short.ubuntu-wsl2#n}}).
- Found flooded single keys made every core fight over one cache line; added a read-only denial path, so one hot key serves {{claim:rl.hot_denied.t8.ubuntu-wsl2}} denied calls/s on eight threads, {{claim:rl.scaling.hot_denied.ubuntu-wsl2}} its single-thread rate ({{claim:rl.hot_denied.t8.ubuntu-wsl2#environment}}, median of {{claim:rl.hot_denied.t8.ubuntu-wsl2#n}}, range {{claim:rl.hot_denied.t8.ubuntu-wsl2#spread}}).
- Verified correctness with {{claim:rl.tests.ubuntu-wsl2}} passing in both measured sessions, Ubuntu on WSL2 (GCC) and native Windows 11 (MSVC), plus ASan and TSan builds in CI.

## Image Quality Gate

- Bounded decoding memory with input limits: a decompression-bomb PNG grew peak server memory by {{claim:iqg.limits.png_bomb_12000x12000.before.rss_growth_mib.ubuntu-wsl2}} MiB before the limits and {{claim:iqg.limits.png_bomb_12000x12000.after.rss_growth_mib.ubuntu-wsl2}} MiB with them ({{claim:iqg.limits.png_bomb_12000x12000.after.rss_growth_mib.ubuntu-wsl2#environment}}, median of {{claim:iqg.limits.png_bomb_12000x12000.after.rss_growth_mib.ubuntu-wsl2#n}}).
- Rejected oversized multipart uploads with HTTP 413 in {{claim:iqg.limits.upload_100mib_content_length.after.elapsed_ms.ubuntu-wsl2}} ms (median of {{claim:iqg.limits.upload_100mib_content_length.after.elapsed_ms.ubuntu-wsl2#n}}, {{claim:iqg.limits.upload_100mib_content_length.after.elapsed_ms.ubuntu-wsl2#environment}}).
- Added a diagnostics endpoint and paired before/after benchmarks: the default POST /quality path changed by {{claim:iqg.sharp_small.current_quality.delta.ubuntu-wsl2}} ms per request (interquartile range {{claim:iqg.sharp_small.current_quality.delta.ubuntu-wsl2#spread}} ms), no measurable slowdown (pooled median of {{claim:iqg.sharp_small.current_quality.delta.ubuntu-wsl2#n}}, {{claim:iqg.sharp_small.current_quality.delta.ubuntu-wsl2#environment}}).
- Shipped it production-style with Docker, Prometheus metrics, request IDs and GitHub Actions CI; its {{claim:iqg.tests.ubuntu-wsl2}} pass on Ubuntu on WSL2 and on native Windows 11.

## Concurrent Key-Value Server

- Built a multithreaded TCP key-value server with a custom SET/GET/REMOVE/PRINT protocol, capped at {{claim:kv.design.max_connections_default}} concurrent clients by default.
- Load-tested it at {{claim:kv.off.c1.cmd_per_s.ubuntu-wsl2}} commands per second with one client and {{claim:kv.off.c16.cmd_per_s.ubuntu-wsl2}} with sixteen (observability off, {{claim:kv.off.c16.cmd_per_s.ubuntu-wsl2#environment}}, median of {{claim:kv.off.c16.cmd_per_s.ubuntu-wsl2#n}} runs).
- Measured what its observability costs at sixteen clients: the in-memory event buffer runs at {{claim:kv.ring_vs_off.c16.ubuntu-wsl2}} and writing every event to a JSONL file at {{claim:kv.jsonl_vs_off.c16.ubuntu-wsl2}} the uninstrumented throughput (instrumented builds, median of {{claim:kv.jsonl_vs_off.c16.ubuntu-wsl2#n}} paired runs, {{claim:kv.jsonl_vs_off.c16.ubuntu-wsl2#environment}}).
- Prevented lost updates by guarding shared state with a reentrant lock and persisting every change, so data survives restarts; covered by {{claim:kv.tests.total.ubuntu-wsl2}}.
