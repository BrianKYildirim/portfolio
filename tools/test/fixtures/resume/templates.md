<!-- Fixture templates: one bullet per project, approved ids only. -->
## Rate Limiter

- Held memory to {{claim:rl.fixture.memory.k1000000}} heap bytes per key ({{claim:rl.fixture.memory.k1000000#environment}}, median of {{claim:rl.fixture.memory.k1000000#n}}); {{claim:rl.fixture.tests}} pass.

## Image Quality Gate

- CI runs {{claim:iqg.fixture.tests}} on every push.

## Key-Value Server

- Capped at {{claim:kv.fixture.max_connections}} concurrent clients by default.
