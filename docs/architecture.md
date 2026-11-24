# Architecture

The React client and Express API share an origin. SQLite stores account state, pairing, profiles, approvals and preferences. The mock adapter simulates catalogue and player state. The Music Assistant adapter uses the same hub policy and streams real audio.

```mermaid
flowchart LR
    Parent["Parent browser"] -->|"Approvals and settings"| Hub["Kids Music Box<br/>React + Express"]
    Child["Paired browser or kiosk"] -->|"Playback commands"| Hub
    Hub -->|"Live state and audio"| Child
    Hub --- DB[("SQLite")]
    Hub -->|"Catalogue and queue API"| MA["Music Assistant"]
    MA -->|"MPD controls and stream URL"| MPD["Hub MPD renderer"]
    MPD -->|"Stream metadata"| Hub
    Hub -->|"Reads MP3 stream"| MA
    Hub -.->|"Optional transcription"| STT["Speech-to-text service"]
```

## Playback sequence

```mermaid
sequenceDiagram
    participant C as Child browser
    participant H as Hub
    participant M as Music Assistant
    C->>H: Choose a song or collection
    H->>H: Verify pairing, profile, approvals and bedtime policy
    H->>M: Start queue on the assigned MPD renderer
    M->>H: Provide the stream URL through MPD
    C->>H: Request the current stream as its owner
    H->>M: Read buffered MP3
    H-->>C: Stream MP3 on the same origin
    C->>C: Decode and play on the device
```

Sleep Music queues one repeating approved song and uses a separate cutoff. The screen schedule is independent of the audio queue. Fully Kiosk can expose Android backlight and media volume controls to the paired child page.

See [API and trust boundaries](api.md) and [Music Assistant setup](music-assistant.md).
