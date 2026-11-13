//! Reader for the safetensors header: an 8-byte little-endian length, a JSON
//! table of tensors, then the raw data.

use std::collections::HashMap;

use serde::Deserialize;

pub struct Tensor {
    pub shape: Vec<usize>,
    /// Absolute byte range in the file.
    pub start: usize,
    pub end: usize,
}

pub struct Header {
    pub tensors: HashMap<String, Tensor>,
}

#[derive(Deserialize)]
struct Entry {
    dtype: String,
    shape: Vec<usize>,
    data_offsets: [usize; 2],
}

impl Header {
    /// `read(start, end)` returns that byte range of the file.
    pub fn parse(file_len: usize, read: &dyn Fn(usize, usize) -> Vec<u8>) -> Result<Self, String> {
        if file_len < 8 {
            return Err("weights file is truncated".into());
        }
        let prefix = read(0, 8);
        let json_len = u64::from_le_bytes(prefix.try_into().expect("8 bytes")) as usize;
        let data_start = 8 + json_len;
        if data_start > file_len {
            return Err("weights header is larger than the file".into());
        }
        let raw: HashMap<String, serde_json::Value> = serde_json::from_slice(&read(8, data_start))
            .map_err(|e| format!("weights header is not valid JSON: {e}"))?;
        let mut tensors = HashMap::new();
        for (name, value) in raw {
            if name == "__metadata__" {
                continue;
            }
            let entry: Entry =
                serde_json::from_value(value).map_err(|e| format!("tensor {name}: {e}"))?;
            if entry.dtype != "F32" {
                return Err(format!("tensor {name} is {}, expected F32", entry.dtype));
            }
            let [a, b] = entry.data_offsets;
            let count: usize = entry.shape.iter().product();
            if b < a || b - a != count * 4 || data_start + b > file_len {
                return Err(format!("tensor {name} has an invalid byte range"));
            }
            tensors.insert(
                name,
                Tensor {
                    shape: entry.shape,
                    start: data_start + a,
                    end: data_start + b,
                },
            );
        }
        Ok(Self { tensors })
    }

    pub fn get(&self, name: &str) -> Result<&Tensor, String> {
        self.tensors
            .get(name)
            .ok_or_else(|| format!("weights are missing {name}"))
    }
}

pub fn to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}
