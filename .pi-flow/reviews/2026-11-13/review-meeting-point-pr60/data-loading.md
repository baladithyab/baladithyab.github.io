# Data loading and interactive-state facet

Fixed review: base `9ab7a4accade272f5b602b0812e2518f9e2b5ccb` to head `d3d381ff1048e4e9e5566c76a30b8fdc79b6addb`. Reviewer: Opus 5.5, high, source-only; no tests or provider calls.

## Medium: touching a suggestion selects before a scroll can start

`MeetingPlaceSearch.tsx:324–329` selects in `onPointerDown` for button 0, including touch. A swipe in the overflowing suggestion list therefore chooses and closes instead of scrolling. Select on click, retain input focus by preventing mouse-down default, and leave touch gestures uncancelled. Parent browser verification remains required.

## Low: location-validation error survives external correction

`LocationInput` stores an unscoped error. A valid map pick or reset can update the origin but leave `aria-invalid` and the alert behind. Scope the error to the origin state that produced it. Name alone is insufficient when a reset restores the same name with a now-valid node; include node identity.

## Checked without a concrete finding

Autocomplete generations/aborts, region-session isolation and termination, cancellation versus idle-worker reuse, exact graph/origin cache identity, transferable ownership, timer cleanup, provider errors, explicit retry, and bbox order. No reproducible source defect was identified behind public-provider city failures. Provider availability is not established by this review. No browser-baseline workaround is requested.

Review result: Changes requested.
