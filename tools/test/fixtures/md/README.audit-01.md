# Fixture README: AUDIT-01 forms

**Clock.** On the fixture laptop, a FastClock read took about <!-- claim:rl.fixture.clock_fast --> 10.2 ns per call, amortized.

The limiter handled 75.7M ops/s at ~40 ns per check, up to 375 times faster than Redis.

- The service kept sustaining 100+ requests/sec.

```text
throughput: 100+ req/s
```

It served 1,200 requests/sec and 5,000 ops/sec.

The server processed 12,000 commands per second, the engine 2.1 million operations per second.

A lookup took 3 milliseconds.

<!-- claim-waiver: synthetic load setting for the demo, not a measurement --> 100+ req/s of synthetic traffic.
