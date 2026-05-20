---
title: 'SOTA ML by July 2025: From Explicit Features to Implicit World Models'
description: 'Thesis: Modern ML keeps rediscovering the same north star: better compression of the data-generating process yields better generalization and capability. The path there has shifted from explicit, hand‑crafted features to'
publishedAt: '2025-09-14'
updatedAt: '2025-10-20'
tags: []
draft: false
featured: false
sourceNotionId: '26e403a2-d51f-8036-bd7c-f136dd9846bc'
---

> Thesis: Modern ML keeps rediscovering the same north star: better compression of the data-generating process yields better generalization and capability. The path there has shifted from explicit, hand‑crafted features to latent and increasingly implicit representations—learned from scale, in-context structure, and interaction with tools and environments. This post traces that evolution, distills the working theories behind recent SOTA jumps, and sketches testable predictions for what’s next on the road toward AGI.

---

## Table of Contents

---

## Executive Summary

- **Feature processing has moved from explicit to latent to implicit.** Hand‑engineered descriptors → supervised deep latents → _implicit_ functions that _are_ the scene/program (e.g., NeRFs, world models, in‑context learners).

- **Compression ≈ understanding.** Information bottlenecks, MDL views, and grokking all point to the same mechanism: models that compress regularities rather than memorize particulars generalize and reason better.

- **Scaling still works—but it’s directional.** Data > params wins (Chinchilla‑style). MoE and state‑space models (SSMs) decouple compute from capacity. Test‑time compute (deliberate decoding, self‑consistency) converts FLOPs → reasoning.

- **Efficient attention + long context are table stakes.** GQA/MQA, FlashAttention, and RoPE‑extensions made 128k–2M tokens feel practical. Retrieval and external memory re‑introduce _non‑parametric_ knowledge.

- **Generative models are consolidating.** Diffusion remains robust; flow matching offers cleaner training; latent spaces give controllability.

- **Alignment is going post‑RLHF.** DPO/IPO‑style objectives plus AI feedback (Constitutional‑style) reduce brittleness, improve stability, and scale cheaply.

- **Interpretability is becoming a training signal.** Sparse‑autoencoder features, monosemanticity, and tool‑use traces act as scaffolds; they’re not just diagnostics anymore.

---

## 1) The arc: explicit → latent → implicit

**Explicit features** (SIFT/HOG, MFCCs) gave way to **latent features** learned end‑to‑end (CNNs, Transformers). The present shift is toward **implicit** representations—neural functions whose parameters _are the representation_ of scenes, programs, or dynamics:

- **Implicit neural representations**: NeRFs, signed distance fields, and their 3D Gaussian successors encode structure in weights rather than explicit voxels/meshes.

- **In‑context learning**: transient, _ephemeral_ task features formed at inference act like scratch‑pads.

- **Program‑like behavior**: chain‑of‑thought, tool calls, and agent loops externalize internal computation.

**Takeaway:** The frontier is fewer hand‑authored preprocessing steps and more structure _emerging_ inside the model—often discoverable with the right probes or constraints.

---

## 2) Compression as understanding

If a model finds a shorter description for data (latent factors, symmetries, algorithms), it **generalizes** better. Three lenses:

- **Information Bottleneck (IB):** useful reps retain task‑relevant info I(Z;Y)I(Z;Y) while discarding nuisance I(Z;X)I(Z;X). Variational IB makes this trainable.

- **Minimum Description Length (MDL):** the best hypothesis compresses the data + model. Practical wins include weight sharing, low‑rank structure, sparsity.

- **Grokking & double descent:** overparameterized nets often _memorize first_, then later compress to a simpler algorithm that suddenly generalizes. That late “click” is a compression phase transition.

**Why it matters:** When we engineer models to **prefer compressible explanations** (e.g., sparsity, distilled latents, retrieval of canonical chunks), they learn more reusable abstractions and reason more reliably.

---

## 3) Scaling laws & compute optimality

Early scaling laws said “more params, more data, more FLOPs” improves loss as a power law. The refinement: **at fixed compute, you should train \*\*\***smaller**\*** models on **\***more**\*** tokens\*\* (compute‑optimal scaling). Consequences:

- **Data is the real bottleneck.** Deduplication, filtering, mixtures, and synthetic‑data bootstrapping matter as much as architecture.

- **MoE and multi‑token prediction (MTP)** let you grow _capacity_ without linearly growing per‑token compute.

- **Test‑time scaling** (self‑consistency, tool‑use, planning) increasingly substitutes for param count.

---

## 4) Architectures that unlocked the last two years

**Transformers, but cheaper & longer:**

- **KV‑efficient attention:** MQA/GQA shrink KV caches; FlashAttention reduces memory traffic.

- **Positional encodings that extrapolate:** RoPE is the modern default; extensions (e.g., YaRN, LongRoPE) push windows to 128k→2M+ tokens.

- **Mixture‑of‑Experts:** Switch/GShard to modern MoE (e.g., 8×‑64× experts) keeps quality while controlling latency via sparse routing.

- **Beyond attention:** **SSMs** (e.g., Mamba) trade quadratic attention for linear‑time recurrence with competitive long‑range modeling.

**Design heuristics in 2025:**

- Use **GQA** for latency/throughput, **FlashAttention** kernels, **RoPE** + an extension if >128k context, and **MoE** when you can batch big enough.

- Consider **SSMs** for streaming/long‑sequence domains; hybrid stacks (SSM early layers + attention late) are practical.

---

## 5) Generative modeling: diffusion → flows → latent control

- **Diffusion** remains stable and easy to scale; **latent diffusion** made high‑res practical.

- **Flow matching** (and stochastic variants) provides a simpler objective with fewer training pathologies, increasingly matching diffusion quality with faster sampling.

- **Text models** are starting to train with **multi‑token prediction (MTP)** and use **speculative/medusa decoding** at inference to amortize serial costs.

**Emerging pattern:** move computation to training (better latent geometry) and to _parallelizable_ paths at inference.

---

## 6) Long context & memory

Two complementary routes:

1. **Longer native windows:** RoPE‑based extensions (position interpolation, YaRN, LongRoPE/LongRoPE2) make million‑token contexts workable, though careful finetuning and precision choice matters.

2. **External memory & retrieval:** RETRO‑style retrieval and modern RAG/tool‑augmented agents turn param memory into _cache + compute_—fewer hallucinations, easier updates.

**Rule of thumb:** If your prompts creep past ~64k, prefer **retrieval + summarization + local long context** over “just crank the window.”

---

## 7) Data quality, retrieval, and curriculum

- **Data wins:** cleaner mixtures (de‑duped, filtered), targeted domain slices, and curriculum schedules often beat parameter tinkering.

- **Retrieval‑augmented \*\*\***training**\* (not only inference) bakes knowledge access into the model; paired with **continual refresh\*\* it reduces catastrophic staleness.

- **Synthetic data** now seeds niche skill formation (math/code/rubrics) but must be grounded with real distributions to avoid feedback loops.

---

## 8) Inference & systems wins

- **Quantization:** W8A8 (SmoothQuant), W3/4 (GPTQ/AWQ) makes edge/server deployment feasible.

- **KV‑cache tricks:** MQA/GQA + page‑size optimizations dominate throughput; cache compression/eviction matter at long context.

- **Speculative & multi‑head decoding:** speculative sampling and Medusa‑style multi‑token heads trade a bit of auxiliary compute for large wall‑clock wins.

**Litmus test:** Your deployment plan should specify quantization format, KV policy, and decoding acceleration up front.

---

## 9) Alignment & preference learning

- **From RLHF to direct objectives:** DPO/IPO variants fit preferences without off‑policy instability and scale well.

- **AI feedback (Constitutional‑style)** provides abundant, consistent supervision, especially for harmlessness and format adherence.

- **Test‑time verifiers** (self‑critique, debate, tool checks) turn alignment into _procedural guarantees_ rather than a single scalar reward.

---

## 10) Mechanistic interpretability

- **Sparse autoencoders** are surfacing monosemantic features; **circuits** work remixed for transformer attention heads; **superposition** remains the default at scale.

- **Why it matters operationally:** these tools are shifting from post‑hoc to **co‑training** signals (regularizers, feature‑discovery priors) that improve robustness and steerability.

---

## 11) Multimodality, world models, and agents

- **CLIP‑style contrastive pretraining** still underpins robust cross‑modal grounding.

- **Promptable vision backbones** (e.g., SAM) decouple segmentation from labels; great for tool‑augmented agents.

- **World models** (latent dynamics learned from pixels) hint at the long‑term route to agents that _plan_ rather than autocomplete.

**Agent stack heuristic (2025):** perception (frozen or lightly finetuned) → language planner (deliberate decoding) → tools (retrievers, solvers) → verifier → memory.

---

## 12) What SOTA looks like by 2027 (predictions)

_Testable, high‑confidence bets:_

1. **Compute‑optimal pretraining** with **MoE + MTP** becomes standard for large LMs; dense full‑compute pretraining becomes niche.

2. **Million‑token context** is commoditized; **retrieval‑augmented training** outperforms pure long‑context for knowledge tasks at the same cost.

3. **Flow‑trained image/video models** match diffusion quality with 2–4× faster sampling; **latent control** becomes first‑class (editability).

4. **Preference learning** uses mostly **direct objectives + AI feedback**, reserving RL for safety‑critical constraints.

5. **Feature‑level interpretability** (sparse‑autoencoder dictionaries) slips into production as a **regularizer** and **monitor**.

6. **Hybrid stacks** (SSM↔attention) and **tool‑verified decoding** define strong reasoning systems.

_Medium‑confidence bets:_

- **Cross‑model distillation** (vision↔language↔audio) improves grounding and robustness.

- **World‑model planning** shows decisive wins in robotics and sim‑heavy domains, then trickles into text‑first agents for long‑horizon tasks.

---

## 13) Practitioner checklist

- **Data:** Dedup/filter; document mixture recipes; consider retrieval during _training_.

- **Architecture:** FlashAttention + GQA; RoPE + an extension if >128k; MoE if batch allows; consider SSM layers for streaming.

- **Objective:** Add **MTP** for text; keep auxiliary losses small and targeted.

- **Context:** Prefer retrieval + summaries; reserve ultra‑long context for local coherence and citations.

- **Inference:** Pick quantization (W8A8 or W4/W3), cache policy, and decoding acceleration (speculative/Medusa) before serving.

- **Alignment:** Use DPO‑style objectives with constitutions/rubrics; add verifiers for critical domains.

- **Interpretability:** Train sparse‑autoencoder feature dictionaries; monitor features tied to safety and reliability.

---

**Scaling laws & compute-optimal training**

- Kaplan et al., _Scaling Laws for Neural Language Models_. [arXiv+1](https://arxiv.org/abs/2001.08361?utm_source=chatgpt.com)

- Hoffmann et al., _Training Compute-Optimal Large Language Models (Chinchilla)_. [arXiv+2arXiv+2](https://arxiv.org/abs/2203.15556?utm_source=chatgpt.com)

**Long context & positional methods**

- Su et al., _RoFormer: Rotary Position Embedding (RoPE)_. [arXiv+1](https://arxiv.org/abs/2104.09864?utm_source=chatgpt.com)

- Peng et al., _YaRN: Efficient Context Window Extension_. [OpenReview](https://openreview.net/pdf?id=wHBfxhZu1u&utm_source=chatgpt.com)

- Ding et al., _LongRoPE: Beyond 2M tokens_. [arXiv](https://arxiv.org/pdf/2402.13753?utm_source=chatgpt.com)

**KV-efficient attention**

- Shazeer, _Fast Transformer Decoding: One Write-Head is All You Need_ (MQA). [arXiv](https://arxiv.org/abs/1911.02150?utm_source=chatgpt.com)

- Ainslie et al., _GQA: Training Generalized Multi-Query Transformer Models_ (GQA). [arXiv+2arXiv+2](https://arxiv.org/abs/2305.13245?utm_source=chatgpt.com)

**Retrieval & external memory**

- Borgeaud et al., _RETRO: Improving LMs by Retrieving from Trillions of Tokens_ (paper + PMLR). [arXiv+1](https://arxiv.org/abs/2112.04426?utm_source=chatgpt.com)

- Izacard et al., _Atlas: Few-shot Learning with Retrieval-Augmented LMs_ (JMLR/ArXiv). [Journal of Machine Learning Research+1](https://jmlr.org/papers/volume24/23-0037/23-0037.pdf?utm_source=chatgpt.com)

**Alignment & preference learning**

- Christiano et al., _Deep RL from Human Preferences (RLHF)_. [arXiv+1](https://arxiv.org/abs/1706.03741?utm_source=chatgpt.com)

- Rafailov et al., _Direct Preference Optimization (DPO)_. [arXiv+1](https://arxiv.org/abs/2305.18290?utm_source=chatgpt.com)

**Interpretability & generalization phenomena**

- Power et al., _Grokking: Generalization Beyond Overfitting_. [arXiv](https://arxiv.org/abs/2201.02177?utm_source=chatgpt.com)

- Belkin et al., _Reconciling modern ML practice and the classical bias-variance trade-off (double descent)_. [PNAS](https://www.pnas.org/doi/10.1073/pnas.1903070116?utm_source=chatgpt.com)

**Multimodality & world models**

- Radford et al., _CLIP_. [arXiv](https://arxiv.org/pdf/2103.00020?utm_source=chatgpt.com)

- Kirillov et al., _Segment Anything (SAM)_ (ICCV/CVF). [CVF Open Access](https://openaccess.thecvf.com/content/ICCV2023/papers/Kirillov_Segment_Anything_ICCV_2023_paper.pdf?utm_source=chatgpt.com)

- Ha & Schmidhuber, _World Models_; Hafner et al., _PlaNet_; Hafner et al., _Dreamer_.

**Multimodality & world models**

- Radford et al., _CLIP_. [arXiv](https://arxiv.org/pdf/2103.00020?utm_source=chatgpt.com)

- Kirillov et al., _Segment Anything (SAM)_ (ICCV/CVF). [CVF Open Access](https://openaccess.thecvf.com/content/ICCV2023/papers/Kirillov_Segment_Anything_ICCV_2023_paper.pdf?utm_source=chatgpt.com)

- Ha & Schmidhuber, _World Models_; Hafner et al., _PlaNet_; Hafner et al., _Dreamer_. [arXiv+2Proceedings of Machine Learning Research+2](https://arxiv.org/abs/1803.10122?utm_source=chatgpt.com)
