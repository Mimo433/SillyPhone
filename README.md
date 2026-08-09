# SillyPhone 📱

A full-featured smartphone simulation extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

## Features

- **Draggable phone icon (FAB)** — floating button you can place anywhere on screen
- **Draggable phone panel** — drag the phone by its status bar to reposition it
- **📞 Dialer** — call any NPC with full AI-driven conversation transcripts
- **💬 Messages (SMS)** — two-way AI-powered text message threads with any NPC
- **🔍 Google** — AI-generated web browsing in your story's world
- **🤖 Reddit** — AI-generated subreddits, posts, comments, and upvotes
- **🏪 App Store** — design and install fully AI-generated custom apps
- **📷 Camera** — take selfies and scene photos (via SillyTavern's /imagine)
- **🖼️ Gallery** — browse and view all generated photos
- **👥 Contacts** — manage your NPC contact list
- **🤖 NPC Auto-Contact** — NPCs will spontaneously text/call you based on story context
- **📡 Context Injection** — recent phone activity is automatically injected into the AI's context
- **Active Card Context** — the current character card's world info is included in all phone prompts
- **Multiple skins** — Default, Sci-Fi, and Horror themes

---

## Installation

### Method 1: SillyTavern Extension Manager (Recommended)
1. In SillyTavern, go to **Extensions** → **Install extension**
2. Paste: `https://github.com/Mimo433/SillyPhone`
3. Click Install

### Method 2: Manual
1. Download this repository
2. Copy the `SillyPhone` folder to:
   ```
   SillyTavern/public/scripts/extensions/third-party/SillyPhone/
   ```
3. Reload SillyTavern

---

## Usage

1. After installing, a 📱 phone icon will appear on your screen
2. Click it to open the phone — drag it to reposition it
3. Drag the phone panel by its **status bar** to move it around
4. Configure settings in **Extensions** → **SillyPhone** (sidebar)

### NPC Auto-Contact
NPCs will automatically text or call you after AI turns if:
- The NPC is in your contacts list
- The narrative context makes it plausible
- The NPC contact chance setting is > 0%

### Context Injection
The extension automatically injects a `[PHONE_ACTIVITY]` block into the AI context, keeping the AI aware of your recent phone interactions.

---

## Settings

| Setting | Description |
|---|---|
| Enable SillyPhone | Master toggle |
| Include Active Card Context | Include the current character card's world info in AI prompts |
| Context Depth | How many recent phone events to inject into AI context |
| NPC Contact Chance % | Probability per AI turn that an NPC will contact you |

---

## Requirements

- SillyTavern 1.10.0+
- Any connected AI backend (for phone app features)
- SillyTavern's `/imagine` slash command (for Camera/image generation — optional)

---

## License

MIT © Mimo433
