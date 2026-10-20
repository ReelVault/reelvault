# TODO

- Unify existence and not-found checks. `assertFound` only rejects `null`/`undefined`, so a boolean `isExists()` result such as `false` passes it. Pick one helper set (`assertFound`, a boolean `assertTrue`/`assertExists`, and `assertPresent`) and migrate the mixed call sites deliberately, with tests for each shape.

