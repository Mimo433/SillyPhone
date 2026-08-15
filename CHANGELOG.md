# SillyPhone Changelog

## [1.3.0] - Automated Navigation & Persistent Visuals

### ✨ New Features

#### **[Experimental] Automated Phone Navigation**
- SillyPhone can now automatically operate itself based on your roleplay!
- When enabled in settings, a background AI task will read your chat messages (e.g. if you write "I tap the Reddit notification to read the message").
- If it detects you interacting with the phone in your roleplay, it will automatically open the phone UI and navigate directly to the correct app or screen (like opening a specific NPC's messages or a specific subreddit) without you needing to click anything!

#### **Mobile Layout Support ("Phone Mode")**
- Added a new `Phone Mode` toggle in settings designed for playing on mobile devices.
- When enabled, the phone interface is scaled down slightly to fit on smaller screens.
- The floating phone icon now forcefully spawns in the exact center of your screen so it is always within reach and never cut off by mobile browser UI bars.

#### **Persistent Visual Profiles for NPCs/Users**
- Profile generation now strictly adheres to a customizable `Profile Visual Prompt` (configurable in settings).
- By default, it generates a detailed visual description of the character (body type, hair style, clothing, glasses, etc.) and permanently caches it to their profile.
- This visual profile is displayed at the bottom of their profile page as an OOC reference so you can imagine what they look like even if you don't generate images.
- When this character makes a Reddit post with an attached image, their specific visual profile is injected directly into the image prompt, guaranteeing that their physical appearance remains 100% consistent across all their posts!


## [1.2.0] - Reddit Expansion & QoL Updates

### ✨ New Features

#### **Massive Reddit Expansion**
The Reddit app has been transformed into a fully interactive platform:
- **Tabs Navigation**: Added a bottom navigation bar with 5 tabs: **Discover**, **Joined**, **Following**, **Chats**, and **Saved**.
- **Search & Custom Communities**: Added a search bar to jump to any subreddit. You can now also create "Custom Subs" by specifying a name, icon, and description, which heavily guides the AI's content generation for that community.
- **Join & Save**: You can now `Join` communities to add them to your Joined tab. Every post also has a `📑 Save` button to bookmark it into your Saved tab for later reading.
- **User Profiles & Following**: Clicking any `u/username` opens their dynamically generated profile page with a bio and recent posts. You can follow users to see them in your Following tab.
- **Refresh Activity**: A `↻` button on user profiles allows you to generate new recent posts while strictly maintaining the user's existing bio/vibe.
- **Direct Messages**: You can start private DM threads with any Reddit user from their profile. The AI acts as the internet stranger, and chats are saved in the Reddit "Chats" tab.
- **Load More Comments**: A `↻ Load More` button in comment sections passes the existing thread to the AI to append new comments, expanding the conversation organically.

#### **Image Generation Integration 🖼️**
- **Dynamic Image Prompts**: Reddit posts now dynamically prompt the AI to generate a visual description if the post contains an attached photo.
- **Inline Generation**: Posts with visual descriptions will display a `🖼️ Click to generate image` placeholder. Clicking this executes a background slash command to generate the image directly inline within the post.
- **Customizable Command**: In the SillyPhone settings, you can define exactly which slash command is used to generate images (e.g., `/draw "{{prompt}}"`, `/imagine quiet=true "{{prompt}}"`).
- **Customizable AI Instructions**: You can also define the exact instructions given to the AI on *how* to write the image prompt. For example, you can instruct it to use "comma-separated Danbooru tags" if you are generating images via a local Stable Diffusion model!

#### **"Put Down Phone" Feature**
- Added a floating `⬇️ Put down phone` button above the phone screen.
- Automatically tracks how many minutes you spent on the phone.
- When clicked, it injects a message into the roleplay chat: `*You put down the phone after using it for X minutes.*`
- This triggers the AI to naturally react to you finishing your phone usage.
- Added explicit AI instructions in the phone context block to use the recent phone activity to summarize what you were doing.
- **New Settings**: 
  - Toggle to completely disable the auto-send feature.
  - Toggle to place the message into your chat textbox (so you can edit it) instead of automatically sending it.

#### **Multihog Integration**
- Added `Multihog Mode` setting. When enabled, SillyPhone dynamically reads the active Player Character's name and bio from the SillyTavern-MultihogDnDFramework state, ensuring your Reddit replies and SMS contexts perfectly match your current Multihog persona.

### 🐛 Bug Fixes & Improvements
- **Floating Action Button (FAB) Physics**: Refactored the floating phone icon to correctly distinguish between a click (to open the phone) and a drag (to move the icon), fixing the issue where clicking the icon would sometimes just drag it.
- **Reddit AI Directives**: Implemented strict instructions across all Reddit system prompts to prevent "Main Character Syndrome." Reddit posts are now strictly about general worldly events, random internet culture, and unrelated strangers, rather than centering on the player character.
- **Context Preservation**: Profile generation now passes the specific post/comment context where the user was found, ensuring the generated profile accurately reflects the personality of their recent comment.
