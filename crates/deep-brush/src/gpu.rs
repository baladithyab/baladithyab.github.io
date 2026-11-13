//! Device setup and the small helpers every pass shares.

use wgpu::util::DeviceExt;

pub struct Gpu {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Adapter name and backend, for status lines.
    pub name: String,
}

impl Gpu {
    /// Requests the adapter's full limits: the depth model needs storage
    /// buffers larger than the WebGPU defaults for wide images.
    pub async fn new(
        instance: &wgpu::Instance,
        surface: Option<&wgpu::Surface<'_>>,
    ) -> Result<Self, String> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: surface,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("no WebGPU adapter: {e}"))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("deep-brush"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..Default::default()
            })
            .await
            .map_err(|e| format!("could not open the GPU device: {e}"))?;
        let info = adapter.get_info();
        // Browsers withhold the adapter name unless asked for it explicitly.
        let name = if info.name.is_empty() {
            "WebGPU".to_string()
        } else {
            format!("{} ({:?})", info.name, info.backend)
        };
        Ok(Self {
            adapter,
            device,
            queue,
            name,
        })
    }

    pub fn storage(&self, label: &str, bytes: u64) -> wgpu::Buffer {
        self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: bytes.max(4),
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    pub fn storage_init(&self, label: &str, data: &[f32]) -> wgpu::Buffer {
        let data: &[f32] = if data.is_empty() { &[0.0] } else { data };
        self.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            })
    }

    pub fn uniform_init(&self, label: &str, bytes: &[u8]) -> wgpu::Buffer {
        self.device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytes,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            })
    }

    pub fn readback(&self, label: &str, bytes: u64) -> wgpu::Buffer {
        self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    pub fn compute_pipeline(&self, label: &str, source: &str) -> wgpu::ComputePipeline {
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
        self.device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: None,
                module: &module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            })
    }
}

/// Maps a buffer created by [`Gpu::readback`] after its copy was submitted.
pub async fn read_buffer(gpu: &Gpu, buffer: &wgpu::Buffer) -> Result<Vec<u8>, String> {
    let slice = buffer.slice(..);
    let (sender, receiver) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    #[cfg(not(target_arch = "wasm32"))]
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| e.to_string())?;
    #[cfg(target_arch = "wasm32")]
    let _ = gpu;
    receiver
        .await
        .map_err(|_| "GPU readback was cancelled".to_string())?
        .map_err(|e| format!("GPU readback failed: {e}"))?;
    let data = slice
        .get_mapped_range()
        .map_err(|e| format!("GPU readback failed: {e}"))?
        .to_vec();
    buffer.unmap();
    Ok(data)
}
