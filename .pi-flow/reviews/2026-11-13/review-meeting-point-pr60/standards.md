# Standards axis

Fixed comparison: `9ab7a4a...d3d381f`. Reviewer: native `Pr60Standards` (`reviewer-astra`). Read-only source/archive review; no execution or edits.

## Medium: overlapping candidate markers select the wrong result

Location: `src/components/MeetingMap.tsx`, `markerHit` (fixed-head lines 866–877); candidate drawing lines 694–722.

Markers paint in ascending result order, but hit testing uses ascending `findIndex` with a 16px radius. An earlier result's expanded hit region can intercept a click at a later, visibly overlaid marker's center.

Static reachable scenario: SF defaults/fair objective/final routes/fit view on a 320px canvas. Candidate 6 (Market Street & Portola Drive, node 63940) and candidate 1 (21st Street & Eureka Street, node 56474) project about 15.6px apart. Clicking candidate 6's visible center selects candidate 1.

Evidence: fixed-head code, SF node coordinates and phase-0 archived default results. Browser reproduction has not yet been executed by the integration owner.

Smallest suggested policy: resolve visible marker footprints in reverse paint order before expanded padding. Preserve reveal opacity threshold, selected-marker sizing and trail history; add an overlapping-candidate behavior regression.

## Other results and limits

No additional concrete findings in playback, result cards, traversal bucketing or inspected tests. Network-change zoom carryover was ruled out because the loading branch unmounts playback. The reviewer did not claim cross-model-family independence or merge approval.

Review result: changes requested
