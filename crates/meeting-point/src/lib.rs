//! WASM prototype boundary for prepared meeting-point searches.
//!
//! Each solve returns two independently consumable owned blocks. JavaScript
//! takes both blocks and frees the batch, then eventually frees the search.
//! No output borrows WASM memory or another search's result.

pub mod kernel;

use kernel::Graph;
use wasm_bindgen::prelude::*;

/// A prepared graph and reusable shortest-path heap, used serially by a worker.
#[wasm_bindgen]
pub struct MeetingSearch {
    graph: Graph,
}

#[wasm_bindgen]
impl MeetingSearch {
    #[wasm_bindgen(constructor)]
    pub fn new(
        node_count: u32,
        edge_pairs: &[u32],
        edge_weights: &[f64],
    ) -> Result<MeetingSearch, JsError> {
        let graph = Graph::new(node_count, edge_pairs, edge_weights)
            .map_err(|error| JsError::new(error.message()))?;
        Ok(Self { graph })
    }

    /// Computes full origin-major trees; ordinary errors leave the graph usable.
    pub fn solve(&mut self, origins: &[u32]) -> Result<SearchBatch, JsError> {
        let trees = self
            .graph
            .solve(origins)
            .map_err(|error| JsError::new(error.message()))?;
        Ok(SearchBatch {
            distances: Some(trees.distances),
            parents: Some(trees.parents),
        })
    }
}

/// Owns both flat result blocks until they are taken or the batch is freed.
/// Taking either block leaves the other available; taking one twice is an error.
#[wasm_bindgen]
pub struct SearchBatch {
    distances: Option<Vec<f64>>,
    parents: Option<Vec<i32>>,
}

#[wasm_bindgen]
impl SearchBatch {
    /// Moves the exact-capacity vector into the generated owned-array export.
    pub fn take_distances(&mut self) -> Result<Vec<f64>, JsError> {
        self.distances
            .take()
            .ok_or_else(|| JsError::new("Distances have already been taken."))
    }

    /// Moves the exact-capacity vector into the generated owned-array export.
    pub fn take_parents(&mut self) -> Result<Vec<i32>, JsError> {
        self.parents
            .take()
            .ok_or_else(|| JsError::new("Parents have already been taken."))
    }
}
