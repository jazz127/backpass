# External session source v1

`external-session-source/v1` describes an immutable set of approved session projections. A manifest declares the source namespace, exact capabilities, coverage counts, and a canonical digest for each payload. Each payload has its own approval digest and contains ordered, screened message and tool events with opaque evidence references. The validator in `src/sources/external-session-source.js` checks canonical UTF-8 JSON bytes, field shapes, limits, identities, and digests without opening files or approving content.

The manifest's `sourceKind: "external"` and `sourceNamespace` identify the **source adapter** that supplies the projection. A payload's `originHarness` identifies the **original harness** that produced the session. These identities serve different purposes and can differ.

The synthetic golden fixtures under `test/fixtures/external-session-source/v1/` pin accepted bytes, digest values, and stable rejection codes. Consumers must separately confine paths and reject links before reading a snapshot. No external source is wired into Backpass discovery yet; native discovery behavior is unchanged.
