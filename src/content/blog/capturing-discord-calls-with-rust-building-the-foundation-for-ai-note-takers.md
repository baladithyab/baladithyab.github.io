---
title: 'Capturing Discord Calls with Rust: Building the Foundation for AI Note-Takers'
description: 'In today’s world, our fast-paced lives rarely allow us the luxury of remembering every detail from important meetings—or those long Dungeons & Dragons sessions. As a multi-tasker with a notoriously poor memory when it co'
publishedAt: '2025-04-12'
updatedAt: '2025-04-12'
tags: []
draft: false
featured: false
sourceNotionId: '1d3403a2-d51f-8065-9972-f1b929380e8f'
---

In today’s world, our fast-paced lives rarely allow us the luxury of remembering every detail from important meetings—or those long Dungeons & Dragons sessions. As a multi-tasker with a notoriously poor memory when it comes to meetings and collaborative gaming sessions, I set out to build a system that not only captures audio on a per-process basis but also transforms it into structured, actionable insights. This post outlines our progress in building a native Windows audio capture engine using Rust and wasapi‑rs, and how it feeds into a real-time streaming pipeline for transcription, summarization, and even diarization.

---

## 1. The Challenge: Meeting Memory and Multi-Tasking

For anyone juggling multiple meetings or managing long gaming sessions, it’s all too easy for crucial details to slip away. I found that my ability to recall key moments was compromised by the constant overload of simultaneous tasks. The idea was simple yet ambitious: create an AI-powered note-taker that listens to conversations, structures the information as it happens, and even integrates with tools like calendar apps or Slack to trigger follow-ups.

---

## 2. Building the Audio Capture Engine with Rust

### Why Rust and wasapi‑rs?

Rust’s performance, safety guarantees, and low-level access make it an ideal candidate for building real-time applications. Leveraging the wasapi‑rs library, our project began with one primary goal: **capture audio from any native Windows application**—be it Discord, Zoom, or another conferencing tool—at the process level.

### Key Achievements:

- **Process-Level Capture**: Using wasapi‑rs enabled us to hook into specific app processes, ensuring that we capture only the desired audio streams. This was crucial for avoiding background noise and isolating relevant conversations.

- **Native Windows App Integration**: Building a native Windows audio capture engine wasn't trivial. Dealing with WASAPI's intricacies, such as low-latency requirements, synchronization, and error handling, tested our limits—but it was also a masterclass in systems programming that unlocked new possibilities for AI applications.

By overcoming these hurdles, we now have a robust foundation that feeds clean audio streams into our AI pipelines.

---

## 3. Feeding Into a Real-Time Streaming Pipeline

### The Pipeline Overview

Once the raw audio is captured, it becomes the lifeblood of a streaming pipeline designed for real-time transcription and meeting summarization. Here’s how it works:

1. **Audio Ingestion**: The captured stream from wasapi‑rs is fed directly into our audio preprocessing module. This module handles basic noise filtering and normalization.

2. **Speech-to-Text Engine**: The cleaned audio is streamed to a real-time transcription service (think along the lines of engines like Whisper). This service continuously converts spoken words into text.

3. **Meeting Summarization**: In parallel, the transcribed text is processed by a summarization engine. By identifying key points and action items, the system distills lengthy conversations into concise meeting minutes.

4. **Diarization and Voice Memory**: Using models like [Pyannote-Ami](https://github.com/pyannote/pyannote-audio), which combine diarization and separation in a single step, we merge speaker identification with the transcription pipeline. This creates a “voice memory agent” that assigns notes and actions to specific speakers and builds a structured knowledge base.

### Technical Highlights:

- **Real-Time Streaming**: The architecture is designed to operate with low latency, ensuring that summaries and speaker identities are available almost immediately after they’re spoken.

- **Scalability**: The modular design means that the pipeline can eventually scale to accommodate integrations with other systems (more on that below).

---

## 4. Creating a Voice Memory Agent for Meetings

Imagine a system that acts as your personal assistant, silently recording and making sense of every meeting. By merging our diarization pipeline with audio capture, we’ve birthed a voice memory agent—a smart, AI-powered second brain.

### How It Works:

- **Speaker Diarization**: Every participant’s voice is identified and tracked throughout the conversation.

- **Structured Notes**: The agent labels segments of the transcription with speaker tags and timestamps, making it easy to revisit who said what.

- **Actionable Insights**: Beyond simple transcription, the system can extract meeting highlights, follow-ups, and even trigger calendar updates or notifications via Slack.

This means that after a meeting or even an extended DnD session, you can quickly access neatly organized notes that summarize the discussion, decisions, and future action items.

---

## 5. Beyond the Capture: Live Streaming Diarization & Integrations

### Live Streaming Diarization

One of our most exciting advances is the use of the Pyannote-Ami model, which performs diarization and audio source separation simultaneously. This model enables our pipeline to:

- **Dynamically Separate Voices**: Even in chaotic environments, individual speakers are isolated for more accurate transcription.

- **Facilitate Real-Time Monitoring**: As the meeting progresses, diarized segments are continuously updated. This live aspect is crucial for on-the-fly note-taking and even alerts when someone’s input is particularly important.

### Integrating with Your Digital Life

Imagine your meeting notes automatically finding their way into your calendar, Slack channels, or project management tools:

- **Calendar Hooks**: Automatically schedule follow-up tasks based on meeting discussions.

- **Slack Integration**: Post summaries or notifications to your team’s Slack channel, ensuring everyone stays informed.

- **Actionable Dashboards**: Build dashboards that visually represent meeting data, making it easy to track progress over time.

---

## 6. The Journey: Overcoming the Challenges

The path to this breakthrough wasn’t without obstacles. Capturing audio at the process level using Rust and wasapi‑rs presented unique challenges:

- **WASAPI’s Low-Level Complexity**: Navigating Windows’ native audio APIs required in-depth knowledge of both system internals and Rust’s ecosystem. Debugging issues related to latency and synchronization was a steep learning curve.

- **Unlocking New Capabilities**: Despite these hurdles, the work enabled us to capture high-fidelity audio streams, paving the way for real-time AI transcription and diarization. This breakthrough has far-reaching implications for developing smarter, more responsive AI applications that can process human speech in real time.

The dedication to solving these technical puzzles is what drives innovation in the AI space, laying the groundwork for more advanced assistive technologies.

---

## 7. Vision for the Future

Our current work is just the beginning. Looking ahead, our vision encompasses:

- **Enhanced Multi-Modal AI Assistants**: By integrating our audio capture and processing pipeline with visual and text data from meetings, we can create even more comprehensive AI note-takers.

- **Seamless Integration into Daily Tools**: From calendar events to team communication platforms like Slack, our aim is to streamline the workflow and ensure that vital information is never lost.

- **Broadening Use Cases**: Beyond professional meetings, this technology holds promise for gaming sessions, online classes, and any collaborative environment where details matter.

For someone who often struggles to remember every detail—whether it’s the strategy discussion in a board meeting or an epic plot twist during a DnD campaign—this technology offers a lifeline. It’s about empowering individuals to focus on the conversation while the AI takes care of the memory.

---

## Conclusion

Building a native audio capture engine with Rust and wasapi‑rs has been a challenging yet rewarding endeavor. By feeding clean audio into a streaming pipeline for real-time transcription, summarization, and diarization, we’re laying the foundation for AI note-takers that can transform how we capture and remember information. Whether in the boardroom or around the gaming table, our voice memory agent is here to ensure that no important detail ever slips away.

Stay tuned for more updates as we continue to refine our system and integrate it with your favorite tools for a smarter, more connected future.

---

_Happy coding, and may your meetings—and your quests—always be remembered!_
