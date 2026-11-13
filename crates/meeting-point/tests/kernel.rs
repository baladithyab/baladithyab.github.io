//! Contract tests for the meeting-point shortest-path kernel.
//!
//! Expected values are derived by hand from the original JavaScript search
//! (`src/lib/meeting-point.ts`): complete f64 trees with `Infinity`/`-1`
//! sentinels, strict-improvement relaxation, equality stale-skip and the exact
//! min-heap tie behaviour. The randomized tests compare against an independent
//! adjacency-list port of that JavaScript algorithm, bit for bit.
//!
//! Nothing here allocates more than a few megabytes. The capacity-overflow
//! transition is only reachable on a 32-bit address space and is exercised by
//! the generated WebAssembly tests instead.

use meeting_point::kernel::{Graph, SearchError, Trees};

const INF: f64 = f64::INFINITY;

type Edge = (u32, u32, f64);

fn build(count: u32, edges: &[Edge]) -> Graph {
    let pairs: Vec<u32> = edges.iter().flat_map(|&(a, b, _)| [a, b]).collect();
    let weights: Vec<f64> = edges.iter().map(|&(_, _, w)| w).collect();
    Graph::new(count, &pairs, &weights).expect("edges describe a valid graph")
}

fn row(trees: &Trees, count: usize, origin: usize) -> (&[f64], &[i32]) {
    let range = origin * count..(origin + 1) * count;
    (&trees.distances[range.clone()], &trees.parents[range])
}

fn bits(values: &[f64]) -> Vec<u64> {
    values.iter().map(|value| value.to_bits()).collect()
}

fn assert_row(trees: &Trees, count: usize, origin: usize, distances: &[f64], parents: &[i32]) {
    let (got_distances, got_parents) = row(trees, count, origin);
    assert_eq!(got_distances, distances, "origin {origin} distances");
    assert_eq!(
        bits(got_distances),
        bits(distances),
        "origin {origin} distance bits"
    );
    assert_eq!(got_parents, parents, "origin {origin} parents");
}

/// Origin-major flat blocks whose capacity equals their length, so the
/// WebAssembly binding can hand them over without a reallocation.
fn assert_shape(trees: &Trees, count: usize, origins: usize) {
    assert_eq!(trees.distances.len(), count * origins);
    assert_eq!(trees.parents.len(), count * origins);
    assert_eq!(trees.distances.capacity(), trees.distances.len());
    assert_eq!(trees.parents.capacity(), trees.parents.len());
}

fn same_bits(trees: &Trees, distances: &[f64], parents: &[i32]) -> bool {
    bits(&trees.distances) == bits(distances) && trees.parents == parents
}

// Hand graph (6 nodes): a diamond 0-1-3 / 0-2-3 with a short tail 3-4 and an
// isolated node 5.
const HAND: [Edge; 5] = [
    (0, 1, 1.0),
    (0, 2, 1.0),
    (1, 3, 1.0),
    (2, 3, 1.0),
    (3, 4, 0.25),
];
const FROM_ZERO: ([f64; 6], [i32; 6]) = ([0.0, 1.0, 1.0, 2.0, 2.25, INF], [-1, 0, 0, 1, 3, -1]);
const FROM_FOUR: ([f64; 6], [i32; 6]) = ([2.25, 1.25, 1.25, 0.25, 0.0, INF], [1, 3, 3, 4, -1, -1]);
const FROM_FIVE: ([f64; 6], [i32; 6]) = ([INF, INF, INF, INF, INF, 0.0], [-1; 6]);

#[test]
fn builds_complete_origin_major_trees_with_unreachable_sentinels() {
    let mut graph = build(6, &HAND);
    let trees = graph.solve(&[0, 4]).expect("valid origins");
    assert_shape(&trees, 6, 2);
    assert_row(&trees, 6, 0, &FROM_ZERO.0, &FROM_ZERO.1);
    assert_row(&trees, 6, 1, &FROM_FOUR.0, &FROM_FOUR.1);
}

#[test]
fn duplicate_origins_are_separate_people_with_their_own_rows() {
    let mut graph = build(6, &HAND);
    let trees = graph.solve(&[0, 0, 4]).expect("duplicates are valid");
    assert_shape(&trees, 6, 3);
    assert_row(&trees, 6, 0, &FROM_ZERO.0, &FROM_ZERO.1);
    assert_row(&trees, 6, 1, &FROM_ZERO.0, &FROM_ZERO.1);
    assert_row(&trees, 6, 2, &FROM_FOUR.0, &FROM_FOUR.1);

    let same = graph.solve(&[5, 5]).expect("all duplicates are valid");
    assert_row(&same, 6, 0, &FROM_FIVE.0, &FROM_FIVE.1);
    assert_row(&same, 6, 1, &FROM_FIVE.0, &FROM_FIVE.1);
}

#[test]
fn sixteen_alternating_origins_keep_every_row_in_request_order() {
    let mut graph = build(6, &HAND);
    let origins: Vec<u32> = (0..16).map(|i| if i % 2 == 0 { 0 } else { 4 }).collect();
    let trees = graph.solve(&origins).expect("sixteen origins");
    assert_shape(&trees, 6, 16);
    for index in 0..16 {
        let (distances, parents) = if index % 2 == 0 {
            &FROM_ZERO
        } else {
            &FROM_FOUR
        };
        assert_row(&trees, 6, index, distances, parents);
    }
}

#[test]
fn disconnected_origins_reach_only_themselves() {
    let mut graph = build(6, &HAND);
    let trees = graph.solve(&[0, 5]).expect("isolated origin is valid");
    assert_row(&trees, 6, 0, &FROM_ZERO.0, &FROM_ZERO.1);
    assert_row(&trees, 6, 1, &FROM_FIVE.0, &FROM_FIVE.1);
}

#[test]
fn graphs_without_edges_or_with_one_node_are_valid() {
    let mut empty = build(3, &[]);
    let trees = empty.solve(&[2, 0]).expect("zero-edge graph");
    assert_shape(&trees, 3, 2);
    assert_row(&trees, 3, 0, &[INF, INF, 0.0], &[-1, -1, -1]);
    assert_row(&trees, 3, 1, &[0.0, INF, INF], &[-1, -1, -1]);

    let mut single = build(1, &[]);
    let trees = single.solve(&[0, 0]).expect("single node");
    assert_shape(&trees, 1, 2);
    assert_row(&trees, 1, 0, &[0.0], &[-1]);
    assert_row(&trees, 1, 1, &[0.0], &[-1]);

    let mut looped = build(1, &[(0, 0, 0.5)]);
    let trees = looped.solve(&[0, 0]).expect("self loop only");
    assert_row(&trees, 1, 0, &[0.0], &[-1]);
}

#[test]
fn relaxes_only_strict_double_precision_improvements() {
    // 0.1 + 0.2 is 0.30000000000000004 in binary64, so the direct 0.3 edge keeps
    // node 1. Node 3 is first reached at 0.3 and then strictly improved to 0.2.
    let mut graph = build(
        6,
        &[
            (0, 1, 0.3),
            (0, 2, 0.1),
            (2, 1, 0.2),
            (0, 3, 0.3),
            (0, 4, 0.1),
            (4, 3, 0.1),
        ],
    );
    let trees = graph.solve(&[0, 1]).expect("valid origins");
    assert_row(
        &trees,
        6,
        0,
        &[0.0, 0.3, 0.1, 0.2, 0.1, INF],
        &[-1, 0, 0, 4, 0, -1],
    );
    assert_eq!(row(&trees, 6, 0).0[1].to_bits(), 0.3f64.to_bits());
}

#[test]
fn fractions_keep_double_precision_and_the_cheaper_path_wins() {
    let mut direct = build(3, &[(0, 1, 0.1), (1, 2, 0.2), (0, 2, 0.3)]);
    let trees = direct.solve(&[0, 2]).expect("valid origins");
    assert_row(&trees, 3, 0, &[0.0, 0.1, 0.3], &[-1, 0, 0]);
    assert_row(&trees, 3, 1, &[0.3, 0.2, 0.0], &[2, 2, -1]);

    let mut detour = build(3, &[(0, 1, 0.25), (1, 2, 0.5), (0, 2, 1.0)]);
    let trees = detour.solve(&[0, 2]).expect("valid origins");
    assert_row(&trees, 3, 0, &[0.0, 0.25, 0.75], &[-1, 0, 1]);
    assert_row(&trees, 3, 1, &[0.75, 0.5, 0.0], &[1, 2, -1]);
}

#[test]
fn huge_weights_that_overflow_leave_the_target_unreachable() {
    let mut graph = build(3, &[(0, 1, f64::MAX), (1, 2, f64::MAX)]);
    let trees = graph.solve(&[0, 2]).expect("valid origins");
    // MAX + MAX is infinity, which is never a strict improvement over infinity.
    assert_row(&trees, 3, 0, &[0.0, f64::MAX, INF], &[-1, 0, -1]);
    assert_row(&trees, 3, 1, &[INF, f64::MAX, 0.0], &[-1, 2, -1]);
}

#[test]
fn zero_weight_edges_and_loops_never_reparent_earlier_nodes() {
    let mut zero_edge = build(6, &[(0, 1, 0.0), (0, 2, 1.0), (1, 2, 1.0)]);
    let trees = zero_edge.solve(&[0, 1]).expect("valid origins");
    assert_row(
        &trees,
        6,
        0,
        &[0.0, 0.0, 1.0, INF, INF, INF],
        &[-1, 0, 0, -1, -1, -1],
    );
    assert_row(
        &trees,
        6,
        1,
        &[0.0, 0.0, 1.0, INF, INF, INF],
        &[1, -1, 1, -1, -1, -1],
    );

    // A zero-weight triangle plus a zero-weight self loop on node 1.
    let mut cycle = build(3, &[(0, 1, 0.0), (1, 2, 0.0), (2, 0, 0.0), (1, 1, 0.0)]);
    let trees = cycle.solve(&[0, 2]).expect("valid origins");
    assert_row(&trees, 3, 0, &[0.0, 0.0, 0.0], &[-1, 0, 0]);
    assert_row(&trees, 3, 1, &[0.0, 0.0, 0.0], &[2, 2, -1]);
}

#[test]
fn parallel_edges_keep_the_cheapest_and_self_loops_change_nothing() {
    let mut graph = build(3, &[(0, 1, 5.0), (0, 1, 3.0), (1, 2, 1.0), (0, 1, 3.0)]);
    let trees = graph.solve(&[0, 2]).expect("valid origins");
    assert_row(&trees, 3, 0, &[0.0, 3.0, 4.0], &[-1, 0, 1]);
    assert_row(&trees, 3, 1, &[4.0, 1.0, 0.0], &[1, 2, -1]);

    let mut looped = build(
        3,
        &[
            (0, 0, 1.0),
            (0, 1, 2.0),
            (1, 1, 0.0),
            (1, 2, 2.0),
            (2, 2, 7.0),
        ],
    );
    let trees = looped.solve(&[0, 2]).expect("valid origins");
    assert_row(&trees, 3, 0, &[0.0, 2.0, 4.0], &[-1, 0, 1]);
    assert_row(&trees, 3, 1, &[4.0, 2.0, 0.0], &[1, 2, -1]);
}

#[test]
fn equal_priority_ties_follow_the_javascript_heap_order() {
    // Node 4 is reachable through 2 and 3 at the same cost; the heap, not the
    // node number, decides which relaxation is final.
    let mut sink = build(
        6,
        &[
            (0, 1, 1.0),
            (0, 2, 1.0),
            (0, 3, 1.0),
            (2, 4, 1.0),
            (3, 4, 1.0),
        ],
    );
    let trees = sink.solve(&[0, 4]).expect("valid origins");
    assert_row(
        &trees,
        6,
        0,
        &[0.0, 1.0, 1.0, 1.0, 2.0, INF],
        &[-1, 0, 0, 0, 3, -1],
    );

    // Equal-priority children sink past a larger value: the left child moves up.
    let mut left = build(
        6,
        &[
            (0, 1, 1.0),
            (0, 2, 2.0),
            (0, 3, 2.0),
            (0, 4, 3.0),
            (2, 5, 1.0),
            (3, 5, 1.0),
        ],
    );
    let trees = left.solve(&[0, 5]).expect("valid origins");
    assert_row(
        &trees,
        6,
        0,
        &[0.0, 1.0, 2.0, 2.0, 3.0, 3.0],
        &[-1, 0, 0, 0, 0, 2],
    );
}

#[test]
fn equal_length_paths_are_decided_by_edge_insertion_order() {
    let mut via_one = build(4, &[(0, 1, 1.0), (0, 2, 1.0), (1, 3, 1.0), (2, 3, 1.0)]);
    let trees = via_one.solve(&[0, 3]).expect("valid origins");
    assert_row(&trees, 4, 0, &[0.0, 1.0, 1.0, 2.0], &[-1, 0, 0, 1]);

    let mut via_two = build(4, &[(0, 2, 1.0), (0, 1, 1.0), (2, 3, 1.0), (1, 3, 1.0)]);
    let trees = via_two.solve(&[0, 3]).expect("valid origins");
    assert_row(&trees, 4, 0, &[0.0, 1.0, 1.0, 2.0], &[-1, 0, 0, 2]);
}

#[test]
fn origin_count_has_no_arbitrary_cap() {
    let mut graph = build(6, &HAND);
    let origins: Vec<u32> = (0..1100).map(|i| [0, 4, 5][i % 3]).collect();
    let trees = graph.solve(&origins).expect("many duplicate origins");
    assert_shape(&trees, 6, 1100);
    for (index, origin) in origins.iter().enumerate() {
        let (distances, parents) = match *origin {
            0 => &FROM_ZERO,
            4 => &FROM_FOUR,
            _ => &FROM_FIVE,
        };
        assert_row(&trees, 6, index, distances, parents);
    }
}

#[test]
fn long_paths_are_solved_exactly_without_node_or_depth_caps() {
    const N: u32 = 100_000;
    let edges: Vec<Edge> = (0..N - 1).map(|i| (i, i + 1, 1.0)).collect();
    let mut graph = build(N, &edges);
    let middle = N / 2;
    let trees = graph.solve(&[0, N - 1, middle]).expect("valid origins");
    let count = N as usize;
    assert_shape(&trees, count, 3);

    let (d0, p0) = row(&trees, count, 0);
    let (d1, p1) = row(&trees, count, 1);
    let (d2, p2) = row(&trees, count, 2);
    for i in 0..N {
        let at = i as usize;
        assert_eq!(d0[at], f64::from(i), "forward distance {i}");
        assert_eq!(
            p0[at],
            if i == 0 { -1 } else { i as i32 - 1 },
            "forward parent {i}"
        );
        assert_eq!(d1[at], f64::from(N - 1 - i), "backward distance {i}");
        assert_eq!(
            p1[at],
            if i == N - 1 { -1 } else { i as i32 + 1 },
            "backward parent {i}"
        );
        assert_eq!(d2[at], f64::from(i.abs_diff(middle)), "middle distance {i}");
        let expected = match i.cmp(&middle) {
            std::cmp::Ordering::Less => i as i32 + 1,
            std::cmp::Ordering::Equal => -1,
            std::cmp::Ordering::Greater => i as i32 - 1,
        };
        assert_eq!(p2[at], expected, "middle parent {i}");
    }
}

#[test]
fn earlier_outputs_are_owned_and_survive_scratch_reuse() {
    let mut graph = build(6, &HAND);
    let first = graph.solve(&[0, 4]).expect("valid origins");
    let first_distances = first.distances.clone();
    let first_parents = first.parents.clone();

    // A larger and then a smaller solve exercise retained heap scratch.
    let wide: Vec<u32> = (0..40).map(|i| (i % 6) as u32).collect();
    let second = graph.solve(&wide).expect("wide solve");
    let third = graph.solve(&[3, 3]).expect("narrow solve");
    assert_shape(&second, 6, 40);
    assert_shape(&third, 6, 2);

    assert!(same_bits(&first, &first_distances, &first_parents));
    assert_ne!(first.distances.as_ptr(), second.distances.as_ptr());
    assert_ne!(first.parents.as_ptr(), third.parents.as_ptr());

    let again = graph.solve(&[0, 4]).expect("same request again");
    assert!(same_bits(&again, &first_distances, &first_parents));
    assert_ne!(again.distances.as_ptr(), first.distances.as_ptr());
    assert!(same_bits(&first, &first_distances, &first_parents));
}

#[test]
fn invalid_origins_are_rejected_without_disturbing_later_solves() {
    let mut graph = build(6, &HAND);
    let baseline = graph.solve(&[0, 4]).expect("valid origins");
    let distances = baseline.distances.clone();
    let parents = baseline.parents.clone();

    let faults: [&[u32]; 7] = [
        &[],
        &[0],
        &[4],
        &[0, 6],
        &[6, 0],
        &[0, 4, u32::MAX],
        &[0, 4, 5, 6],
    ];
    for origins in faults {
        assert_eq!(
            graph.solve(origins).err(),
            Some(SearchError::InvalidOrigins),
            "{origins:?}"
        );
        let again = graph.solve(&[0, 4]).expect("valid after rejection");
        assert!(same_bits(&again, &distances, &parents), "{origins:?}");
    }
    assert!(same_bits(&baseline, &distances, &parents));
}

#[test]
fn invalid_graph_inputs_report_their_own_error_for_single_faults() {
    assert_eq!(
        Graph::new(0, &[], &[]).err(),
        Some(SearchError::InvalidNodeCount)
    );

    // Odd endpoint list; more pairs than weights; more weights than pairs.
    assert_eq!(
        Graph::new(3, &[0, 1, 2], &[1.0]).err(),
        Some(SearchError::InvalidEdgeCount)
    );
    assert_eq!(
        Graph::new(3, &[0, 1, 1, 2], &[1.0]).err(),
        Some(SearchError::InvalidEdgeCount)
    );
    assert_eq!(
        Graph::new(3, &[0, 1], &[1.0, 1.0]).err(),
        Some(SearchError::InvalidEdgeCount)
    );
    assert_eq!(
        Graph::new(3, &[0, 1], &[]).err(),
        Some(SearchError::InvalidEdgeCount)
    );
    assert_eq!(
        Graph::new(3, &[], &[1.0]).err(),
        Some(SearchError::InvalidEdgeCount)
    );

    for pairs in [[3, 0], [0, 3], [u32::MAX, 0], [0, u32::MAX]] {
        assert_eq!(
            Graph::new(3, &pairs, &[1.0]).err(),
            Some(SearchError::InvalidEndpoint),
            "{pairs:?}"
        );
    }

    for weight in [-1.0, -1e-300, f64::NAN, INF, f64::NEG_INFINITY] {
        assert_eq!(
            Graph::new(3, &[0, 1], &[weight]).err(),
            Some(SearchError::InvalidWeight),
            "{weight}"
        );
    }

    // The count cannot be represented by the i32 parent array.
    assert_eq!(
        Graph::new(u32::MAX, &[], &[]).err(),
        Some(SearchError::IndexOverflow)
    );

    // After failures, graphs still build and solve.
    let mut graph = build(6, &HAND);
    let trees = graph.solve(&[0, 4]).expect("valid origins");
    assert_row(&trees, 6, 0, &FROM_ZERO.0, &FROM_ZERO.1);
}

// --- Randomized differential tests against an adjacency-list port of the JS search ---

struct Rng(u64);

impl Rng {
    fn bits(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 24
    }

    fn below(&mut self, n: u64) -> u64 {
        self.bits() % n
    }

    fn unit(&mut self) -> f64 {
        (self.bits() & 0xFF_FFFF) as f64 / 16_777_216.0
    }
}

/// `kind` 0: tiny integers with zeros (heavy ties); 1: tenths (rounding);
/// 2: arbitrary fractions; 3: halves.
fn random_edges(rng: &mut Rng, count: u32, edge_count: usize, kind: u8) -> Vec<Edge> {
    (0..edge_count)
        .map(|_| {
            let a = rng.below(u64::from(count)) as u32;
            let b = rng.below(u64::from(count)) as u32;
            let weight = match kind {
                0 => rng.below(4) as f64,
                1 => rng.below(10) as f64 * 0.1,
                2 => rng.unit() * 5.0,
                _ => (rng.below(3) + 1) as f64 * 0.5,
            };
            (a, b, weight)
        })
        .collect()
}

fn grid_edges(width: u32, height: u32) -> Vec<Edge> {
    let mut edges = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let id = y * width + x;
            if x + 1 < width {
                edges.push((id, id + 1, 1.0));
            }
            if y + 1 < height {
                edges.push((id, id + width, 1.0));
            }
        }
    }
    edges
}

fn random_origins(rng: &mut Rng, count: u32, origins: usize) -> Vec<u32> {
    (0..origins)
        .map(|_| rng.below(u64::from(count)) as u32)
        .collect()
}

struct ReferenceHeap {
    nodes: Vec<usize>,
    values: Vec<f64>,
}

impl ReferenceHeap {
    fn push(&mut self, node: usize, value: f64) {
        let mut i = self.nodes.len();
        self.nodes.push(node);
        self.values.push(value);
        while i > 0 {
            let parent = (i - 1) >> 1;
            if self.values[parent] <= value {
                break;
            }
            self.nodes[i] = self.nodes[parent];
            self.values[i] = self.values[parent];
            i = parent;
        }
        self.nodes[i] = node;
        self.values[i] = value;
    }

    fn pop(&mut self) -> (usize, f64) {
        let node = self.nodes[0];
        let value = self.values[0];
        let last_node = self.nodes.pop().expect("non-empty heap");
        let last_value = self.values.pop().expect("non-empty heap");
        let length = self.nodes.len();
        if length > 0 {
            let mut i = 0;
            while 2 * i + 1 < length {
                let mut child = 2 * i + 1;
                if child + 1 < length && self.values[child + 1] < self.values[child] {
                    child += 1;
                }
                if self.values[child] >= last_value {
                    break;
                }
                self.nodes[i] = self.nodes[child];
                self.values[i] = self.values[child];
                i = child;
            }
            self.nodes[i] = last_node;
            self.values[i] = last_value;
        }
        (node, value)
    }
}

fn reference(count: usize, edges: &[Edge], origins: &[u32]) -> (Vec<f64>, Vec<i32>) {
    let mut adjacency: Vec<Vec<(usize, f64)>> = vec![Vec::new(); count];
    for &(a, b, weight) in edges {
        adjacency[a as usize].push((b as usize, weight));
        adjacency[b as usize].push((a as usize, weight));
    }
    let mut distances = Vec::with_capacity(count * origins.len());
    let mut parents = Vec::with_capacity(count * origins.len());
    for &origin in origins {
        let mut best = vec![INF; count];
        let mut parent = vec![-1i32; count];
        let mut heap = ReferenceHeap {
            nodes: Vec::new(),
            values: Vec::new(),
        };
        best[origin as usize] = 0.0;
        heap.push(origin as usize, 0.0);
        while !heap.nodes.is_empty() {
            let (node, distance) = heap.pop();
            if distance != best[node] {
                continue;
            }
            for &(target, weight) in &adjacency[node] {
                let next = distance + weight;
                if next < best[target] {
                    best[target] = next;
                    parent[target] = node as i32;
                    heap.push(target, next);
                }
            }
        }
        distances.extend_from_slice(&best);
        parents.extend_from_slice(&parent);
    }
    (distances, parents)
}

fn assert_matches_reference(
    label: &str,
    count: u32,
    edges: &[Edge],
    graph: &mut Graph,
    origins: &[u32],
) {
    let want = reference(count as usize, edges, origins);
    let got = graph.solve(origins).expect("valid origins");
    assert_shape(&got, count as usize, origins.len());
    if let Some(i) = (0..want.0.len()).find(|&i| got.distances[i].to_bits() != want.0[i].to_bits())
    {
        panic!(
            "{label}: distance {i} (origin {}, node {}): got {} want {}",
            i / count as usize,
            i % count as usize,
            got.distances[i],
            want.0[i]
        );
    }
    if let Some(i) = (0..want.1.len()).find(|&i| got.parents[i] != want.1[i]) {
        panic!(
            "{label}: parent {i} (origin {}, node {}): got {} want {}",
            i / count as usize,
            i % count as usize,
            got.parents[i],
            want.1[i]
        );
    }
}

#[test]
fn random_small_graphs_match_the_reference_for_every_origin_group() {
    let mut rng = Rng(0x5EED_0001);
    for case in 0..60u32 {
        let count = 1 + rng.below(60) as u32;
        let edge_count = rng.below(u64::from(count) * 4 + 1) as usize;
        let kind = (case % 4) as u8;
        let edges = random_edges(&mut rng, count, edge_count, kind);
        let mut graph = build(count, &edges);
        // One prepared graph answers several differently sized groups in a row.
        for round in 0..4u32 {
            let size = 2 + rng.below(19) as usize;
            let origins = random_origins(&mut rng, count, size);
            assert_matches_reference(
                &format!("small case {case} kind {kind} round {round}"),
                count,
                &edges,
                &mut graph,
                &origins,
            );
        }
    }
}

#[test]
fn random_large_graphs_and_grids_match_the_reference_with_heavy_ties() {
    let mut rng = Rng(0x5EED_0002);
    for (label, count, edges) in [
        ("grid 40x40", 1600u32, grid_edges(40, 40)),
        ("grid 7x300", 2100, grid_edges(7, 300)),
    ] {
        let mut graph = build(count, &edges);
        let origins = random_origins(&mut rng, count, 16);
        assert_matches_reference(label, count, &edges, &mut graph, &origins);
        let corners = [0, count - 1, count / 2, count / 2, 0];
        assert_matches_reference(label, count, &edges, &mut graph, &corners);
    }

    for kind in 0..4u8 {
        let count = 3000;
        let edges = random_edges(&mut rng, count, 9000, kind);
        let mut graph = build(count, &edges);
        for _ in 0..2 {
            let origins = random_origins(&mut rng, count, 16);
            assert_matches_reference(
                &format!("random 3000 kind {kind}"),
                count,
                &edges,
                &mut graph,
                &origins,
            );
        }
    }
}

#[test]
fn reference_agreement_survives_interleaved_rejections() {
    let mut rng = Rng(0x5EED_0003);
    let count = 500;
    let edges = random_edges(&mut rng, count, 1500, 1);
    let mut graph = build(count, &edges);
    for round in 0..8 {
        let origins = random_origins(&mut rng, count, 2 + round);
        assert_matches_reference(
            &format!("round {round}"),
            count,
            &edges,
            &mut graph,
            &origins,
        );
        assert_eq!(graph.solve(&[1]).err(), Some(SearchError::InvalidOrigins));
        assert_eq!(
            graph.solve(&[0, count]).err(),
            Some(SearchError::InvalidOrigins)
        );
    }
}
