//! Complete shortest-path trees with the JavaScript reference's adjacency and
//! heap tie order. Graph preparation and every search allocation are fallible.

use core::fmt;

/// Input, representation, or allocation failure; messages need no allocation.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum SearchError {
    InvalidNodeCount,
    InvalidEdgeCount,
    InvalidEndpoint,
    InvalidWeight,
    InvalidOrigins,
    IndexOverflow,
    Allocation,
}

impl SearchError {
    pub const fn message(self) -> &'static str {
        match self {
            Self::InvalidNodeCount => "The network must contain at least one node.",
            Self::InvalidEdgeCount => "Edge pairs and weights have different lengths.",
            Self::InvalidEndpoint => "An edge endpoint is outside the network.",
            Self::InvalidWeight => "Edge weights must be finite and nonnegative.",
            Self::InvalidOrigins => "Choose at least two valid starting locations.",
            Self::IndexOverflow => "The search exceeds its index representation.",
            Self::Allocation => "Unable to allocate memory for the search.",
        }
    }
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

/// Independently owned, origin-major blocks, each row containing every node.
/// Unreachable nodes have distance infinity and parent -1; origins have 0/-1.
#[derive(Debug)]
pub struct Trees {
    pub distances: Vec<f64>,
    pub parents: Vec<i32>,
}

/// Undirected CSR in original edge insertion order and reusable heap scratch.
/// Calls are serial; a later solve never borrows or changes earlier output.
#[derive(Debug)]
pub struct Graph {
    offsets: Vec<u32>,
    targets: Vec<u32>,
    weights: Vec<f64>,
    heap: Vec<HeapEntry>,
}

#[derive(Debug, Copy, Clone)]
struct HeapEntry {
    node: u32,
    distance: f64,
}

impl Graph {
    /// Retains both directions, including both entries of every self-loop.
    /// Empty edge lists, parallel edges, and finite zero weights are valid.
    pub fn new(
        node_count: u32,
        edge_pairs: &[u32],
        edge_weights: &[f64],
    ) -> Result<Self, SearchError> {
        if node_count == 0 {
            return Err(SearchError::InvalidNodeCount);
        }
        if node_count - 1 > i32::MAX as u32 {
            return Err(SearchError::IndexOverflow);
        }
        if edge_pairs.len() % 2 != 0 || edge_pairs.len() / 2 != edge_weights.len() {
            return Err(SearchError::InvalidEdgeCount);
        }
        if edge_pairs.iter().any(|&node| node >= node_count) {
            return Err(SearchError::InvalidEndpoint);
        }
        if edge_weights
            .iter()
            .any(|&weight| !weight.is_finite() || weight < 0.0)
        {
            return Err(SearchError::InvalidWeight);
        }

        let count = usize::try_from(node_count).map_err(|_| SearchError::IndexOverflow)?;
        let offset_count = count.checked_add(1).ok_or(SearchError::IndexOverflow)?;
        // One adjacency entry per endpoint; this also bounds every degree,
        // prefix sum, and insertion cursor below by u32::MAX.
        let adjacency_count = edge_pairs.len();
        u32::try_from(adjacency_count).map_err(|_| SearchError::IndexOverflow)?;

        let mut offsets = Vec::new();
        let mut targets = Vec::new();
        let mut weights = Vec::new();
        offsets
            .try_reserve_exact(offset_count)
            .map_err(|_| SearchError::Allocation)?;
        targets
            .try_reserve_exact(adjacency_count)
            .map_err(|_| SearchError::Allocation)?;
        weights
            .try_reserve_exact(adjacency_count)
            .map_err(|_| SearchError::Allocation)?;
        offsets.resize(offset_count, 0_u32);
        targets.resize(adjacency_count, 0_u32);
        weights.resize(adjacency_count, 0.0);

        for &node in edge_pairs {
            offsets[node as usize + 1] += 1;
        }
        for node in 0..count {
            offsets[node + 1] += offsets[node];
        }
        // Starts double as insertion cursors. Processing the two endpoints in
        // sequence preserves self-loops as well as parallel-edge ordering.
        for (pair, &weight) in edge_pairs.chunks_exact(2).zip(edge_weights) {
            let a = pair[0] as usize;
            let b = pair[1] as usize;
            let slot = offsets[a] as usize;
            targets[slot] = pair[1];
            weights[slot] = weight;
            offsets[a] += 1;
            let slot = offsets[b] as usize;
            targets[slot] = pair[0];
            weights[slot] = weight;
            offsets[b] += 1;
        }
        // Cursors now hold row ends; shift backwards to restore row starts.
        for node in (1..=count).rev() {
            offsets[node] = offsets[node - 1];
        }
        offsets[0] = 0;

        Ok(Self {
            offsets,
            targets,
            weights,
            heap: Vec::new(),
        })
    }

    /// Computes full trees, including a separate row for each duplicate origin.
    /// Both flat blocks are reserved before either is initialized. Heap capacity
    /// survives every origin and call, including recoverable allocation errors.
    pub fn solve(&mut self, origins: &[u32]) -> Result<Trees, SearchError> {
        let count = self.offsets.len() - 1;
        if origins.len() < 2 || origins.iter().any(|&origin| origin as usize >= count) {
            return Err(SearchError::InvalidOrigins);
        }
        let length = origins
            .len()
            .checked_mul(count)
            .ok_or(SearchError::IndexOverflow)?;
        let mut distances = Vec::new();
        let mut parents = Vec::new();
        distances
            .try_reserve_exact(length)
            .map_err(|_| SearchError::Allocation)?;
        parents
            .try_reserve_exact(length)
            .map_err(|_| SearchError::Allocation)?;
        distances.resize(length, f64::INFINITY);
        parents.resize(length, -1);

        let offsets = self.offsets.as_slice();
        let targets = self.targets.as_slice();
        let weights = self.weights.as_slice();
        let heap = &mut self.heap;
        for ((row_distances, row_parents), &origin) in distances
            .chunks_exact_mut(count)
            .zip(parents.chunks_exact_mut(count))
            .zip(origins)
        {
            search_row(
                offsets,
                targets,
                weights,
                heap,
                row_distances,
                row_parents,
                origin,
            )?;
        }
        Ok(Trees { distances, parents })
    }
}

// Keep immutable CSR slices separate from heap mutation for the whole search.
// Paired adjacency slices preserve insertion order without per-edge CSR indexing.
fn search_row(
    offsets: &[u32],
    targets: &[u32],
    weights: &[f64],
    heap: &mut Vec<HeapEntry>,
    distances: &mut [f64],
    parents: &mut [i32],
    origin: u32,
) -> Result<(), SearchError> {
    // Also discards any entries left by an earlier failed solve.
    heap.clear();
    distances[origin as usize] = 0.0;
    heap_push(
        heap,
        HeapEntry {
            node: origin,
            distance: 0.0,
        },
    )?;
    while let Some(entry) = heap_pop(heap) {
        let node = entry.node as usize;
        if entry.distance != distances[node] {
            continue;
        }
        let start = offsets[node] as usize;
        let end = offsets[node + 1] as usize;
        for (&target, &weight) in targets[start..end].iter().zip(&weights[start..end]) {
            let next = entry.distance + weight;
            if next < distances[target as usize] {
                distances[target as usize] = next;
                parents[target as usize] = entry.node as i32;
                heap_push(
                    heap,
                    HeapEntry {
                        node: target,
                        distance: next,
                    },
                )?;
            }
        }
    }
    Ok(())
}

// Priority alone determines order: equal priorities never use node IDs as a
// secondary key. Entries are copied on the stack, not allocated per push/pop.
fn heap_push(heap: &mut Vec<HeapEntry>, entry: HeapEntry) -> Result<(), SearchError> {
    if heap.len() == heap.capacity() {
        heap.try_reserve(1).map_err(|_| SearchError::Allocation)?;
    }
    let mut index = heap.len();
    heap.push(entry);
    while index > 0 {
        let parent = (index - 1) / 2;
        if heap[parent].distance <= entry.distance {
            break;
        }
        heap[index] = heap[parent];
        index = parent;
    }
    heap[index] = entry;
    Ok(())
}

fn heap_pop(heap: &mut Vec<HeapEntry>) -> Option<HeapEntry> {
    let root = *heap.first()?;
    // Remove the last entry BEFORE testing nonempty, including length one.
    let last = heap.pop()?;
    if !heap.is_empty() {
        let mut index = 0;
        // Only internal nodes have a left child; this also bounds 2*index+1.
        while index < heap.len() / 2 {
            let mut child = 2 * index + 1;
            if child + 1 < heap.len() && heap[child + 1].distance < heap[child].distance {
                child += 1;
            }
            if heap[child].distance >= last.distance {
                break;
            }
            heap[index] = heap[child];
            index = child;
        }
        heap[index] = last;
    }
    Some(root)
}
