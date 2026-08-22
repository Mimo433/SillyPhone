/**
 * SillyPhone — Standalone SillyTavern Extension
 *
 * A full smartphone simulation overlay for SillyTavern.
 * Apps: Contacts, Dialer, Messages (SMS), Google (AI browsing),
 * Reddit (AI feed), App Store (AI-generated persistent apps),
 * Camera (image generation), Gallery, Settings.
 *
 * NPC contacts fire probabilistically weighted by relationship scores.
 * Recent phone activity is injected into the AI context on every turn.
 * Fully standalone — no dependency on any other extension.
 *
 * Author: Mimo433
 * https://github.com/Mimo433/SillyPhone
 */

// ─────────────────────────────────────────────────────────────────────────────
// SillyTavern API bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const ST_EXT_NAME = 'SillyPhone';

/** Resolve the SillyTavern context. Works in both module and classic load modes. */
function getSTContext() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        return SillyTavern.getContext();
    }
    // Fallback for classic extension load
    if (typeof window !== 'undefined' && window.SillyTavern) {
        return window.SillyTavern.getContext?.() || {};
    }
    return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
    enabled: true,
    includeCardContext: true,
    contextDepth: 20,
    npcContactChance: 8,
    fabX: null,
    fabY: null,
    panelX: null,
    panelY: null,
    chatData: {},
    multihogMode: false,
    autoPutDownMessage: true,
    putDownMessageToTextbox: false,
    imageGenCommand: '/imagine quiet=true "{{prompt}}"',
    imagePromptInstruction: 'detailed visual description of the photo if applicable, else empty string',
    phoneMode: false,
    profileVisualPrompt: 'Detailed physical description (body type, size, eye color, facial shape, hair style, hair colors, glasses, makeup, clothing style)',
    experimentalAutoNavigate: false,
    laptopModeEnabled: true,
    phoneScale: 100,
    laptopScale: 100,
};

function getSettings() {
    const ctx = getSTContext();
    if (!ctx.extensionSettings) return { ...DEFAULTS };
    if (!ctx.extensionSettings[ST_EXT_NAME]) {
        ctx.extensionSettings[ST_EXT_NAME] = { ...DEFAULTS };
    }
    const s = ctx.extensionSettings[ST_EXT_NAME];
    // Ensure all defaults present
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function saveSettings() {
    const ctx = getSTContext();
    if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat-scoped phone state
// ─────────────────────────────────────────────────────────────────────────────

function getChatId() {
    try {
        if (typeof globalThis._rpgCurrentChatId === 'function') {
            const id = globalThis._rpgCurrentChatId();
            if (id) return id;
        }
        const ctx = getSTContext();
        return ctx.chatId || ctx.chat_id || '_global';
    } catch { return '_global'; }
}

function getPhoneState() {
    const s = getSettings();
    const id = getChatId();
    if (!id) return null;
    if (!s.chatData) s.chatData = {};
    if (!s.chatData[id]) s.chatData[id] = {};
    const cs = s.chatData[id];
    if (!cs.phoneHistory)  cs.phoneHistory  = [];
    if (!cs.phoneContacts) cs.phoneContacts  = [];
    if (!cs.phoneApps)     cs.phoneApps      = [];
    if (!cs.phoneCallLog)  cs.phoneCallLog   = [];
    if (!cs.phoneMessages) cs.phoneMessages  = {};
    if (!cs.phoneUnread)   cs.phoneUnread    = { messages: 0, calls: 0 };
    if (!cs.phoneGallery)  cs.phoneGallery   = [];
    if (!cs.phoneCache)    cs.phoneCache     = {};
    if (!cs.phoneVotes)    cs.phoneVotes     = {};
    if (!cs.phoneRedditJoinedSubs) cs.phoneRedditJoinedSubs = [];
    if (!cs.phoneRedditFollowing)  cs.phoneRedditFollowing  = [];
    if (!cs.phoneRedditSavedPosts) cs.phoneRedditSavedPosts = [];
    if (!cs.phoneRedditDMs)        cs.phoneRedditDMs        = {};
    return cs;
}

function savePhoneState() {
    saveSettings();
}

// ─────────────────────────────────────────────────────────────────────────────
// AI generation
// ─────────────────────────────────────────────────────────────────────────────

async function sendPhoneRequest(systemPrompt, userPrompt) {
    const ctx = getSTContext();
    if (!ctx.generateRaw) {
        throw new Error('[SillyPhone] generateRaw not available — please update SillyTavern.');
    }
    const result = await ctx.generateRaw({
        prompt: userPrompt,
        systemPrompt: systemPrompt,
        quietToLoud: false,
        skipTemplate: true,
    });
    return typeof result === 'string' ? result : (result?.message || result?.text || JSON.stringify(result));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers (reimplemented standalone)
// ─────────────────────────────────────────────────────────────────────────────

function _escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function _renderIcon(icon, sizeStyle = 'width:100%; height:100%;') {
    if (!icon) return '📱';
    const clean = icon.trim();
    if (clean.startsWith('http') || clean.startsWith('data:image') || clean.startsWith('/')) {
        return `<img src="${_escHtml(clean)}" style="${sizeStyle} object-fit:contain; border-radius:inherit; pointer-events:none; vertical-align:middle;" />`;
    }
    return clean;
}

/** Strip tool call blocks and HTML from AI-generated text */
function cleanToolCallMessage(text) {
    if (!text) return '';
    return String(text)
        .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '')
        .replace(/\[INNER_MONOLOGUE\][\s\S]*?\[\/INNER_MONOLOGUE\]/gi, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _parseJsonRobust(raw, fallback = null) {
    if (!raw || typeof raw !== 'string') return fallback;

    let cleaned = raw.trim();

    // 1. Strip markdown codeblock backticks if present
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    // Try direct parse first if full array or object
    try {
        const match = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (match) {
            return JSON.parse(match[1]);
        }
    } catch (e) {
        // Fall through to repair logic
    }

    // Find first [ or {
    const firstBracket = cleaned.indexOf('[');
    const firstBrace = cleaned.indexOf('{');
    let startIdx = -1;
    let isArray = false;

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        startIdx = firstBracket;
        isArray = true;
    } else if (firstBrace !== -1) {
        startIdx = firstBrace;
        isArray = false;
    }

    if (startIdx === -1) return fallback;

    let candidate = cleaned.slice(startIdx);

    // 2. Fix missing opening quotes on values: e.g. "author":u/name", -> "author": "u/name",
    candidate = candidate.replace(/:\s*([a-zA-Z0-9_\-/\.@]+)"/g, ': "$1"');

    // 3. Fix unquoted identifiers like "author": u/name, or "sub": r/name,
    candidate = candidate.replace(/:\s*(u\/[a-zA-Z0-9_\-]+)(\s*[,}\]])/g, ': "$1"$2');
    candidate = candidate.replace(/:\s*(r\/[a-zA-Z0-9_\-]+)(\s*[,}\]])/g, ': "$1"$2');

    // 4. Fix trailing commas before } or ]
    candidate = candidate.replace(/,\s*([}\]])/g, '$1');

    // Try parsing candidate with matched closing brackets
    try {
        if (isArray) {
            const m = candidate.match(/\[[\s\S]*\]/);
            if (m) return JSON.parse(m[0]);
        } else {
            const m = candidate.match(/\{[\s\S]*\}/);
            if (m) return JSON.parse(m[0]);
        }
    } catch (e) {
        // Fall through to truncation recovery
    }

    // 5. Handle truncation (e.g. LLM ran out of output tokens midway through an array)
    if (isArray) {
        const lastObjEnd = candidate.lastIndexOf('}');
        if (lastObjEnd !== -1) {
            let truncated = candidate.slice(0, lastObjEnd + 1).trim();
            truncated = truncated.replace(/,\s*$/, '') + '\n]';
            truncated = truncated.replace(/,\s*([}\]])/g, '$1');
            try {
                const m = truncated.match(/\[[\s\S]*\]/);
                if (m) return JSON.parse(m[0]);
            } catch (e) {
                // Ignore
            }
        }
    } else {
        // If object was truncated, try closing with }
        const lastFieldEnd = Math.max(candidate.lastIndexOf('"'), candidate.lastIndexOf('true'), candidate.lastIndexOf('false'), candidate.lastIndexOf('null'));
        if (lastFieldEnd !== -1) {
            let truncated = candidate.slice(0, lastFieldEnd + 1).trim() + '\n}';
            truncated = truncated.replace(/,\s*([}\]])/g, '$1');
            try {
                const m = truncated.match(/\{[\s\S]*\}/);
                if (m) return JSON.parse(m[0]);
            } catch (e) {
                // Ignore
            }
        }
    }

    try {
        return JSON.parse(candidate);
    } catch (e) {
        console.warn('[_parseJsonRobust] Failed to parse JSON:', e.message, '\nRaw was:\n', raw);
        return fallback;
    }
}

function _summarizeText(text, maxLen = 140) {
    if (!text) return '';
    const clean = String(text)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[IMAGE:[^\]]*\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen - 1) + '…';
}

// ─────────────────────────────────────────────────────────────────────────────
// In-world time helper (reads from chat if available)
// ─────────────────────────────────────────────────────────────────────────────

function getInWorldTimeInfo() {
    try {
        const ctx = getSTContext();
        // Try to find a [TIME] block in the last few chat messages
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        let rawTime = '';
        for (let i = chat.length - 1; i >= Math.max(0, chat.length - 10); i--) {
            const msg = String(chat[i]?.mes || chat[i]?.content || '');
            const match = msg.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
            if (match) {
                const inner = match[1];
                // Try to extract a time-like pattern
                const tMatch = inner.match(/(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i);
                if (tMatch) { rawTime = tMatch[1].trim(); break; }
            }
        }

        let totalMinutes = null;
        let clockOnly = rawTime;

        if (rawTime) {
            // Parse "HH:MM AM/PM" or "HH:MM"
            const pm = /PM/i.test(rawTime);
            const am = /AM/i.test(rawTime);
            const timeParts = rawTime.replace(/[AP]M/i, '').trim().split(':');
            let h = parseInt(timeParts[0], 10) || 0;
            const m = parseInt(timeParts[1], 10) || 0;
            if (pm && h < 12) h += 12;
            if (am && h === 12) h = 0;
            totalMinutes = h * 60 + m;
        }

        if (!clockOnly) {
            // Fall back to real-world time
            const now = new Date();
            const h = now.getHours();
            const m = now.getMinutes();
            const mer = h >= 12 ? 'PM' : 'AM';
            const h12 = h % 12 || 12;
            clockOnly = `${h12}:${String(m).padStart(2, '0')} ${mer}`;
        }

        return { rawTime, clockOnly, totalMinutes };
    } catch {
        return { rawTime: '', clockOnly: '12:00 PM', totalMinutes: null };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Player character info
// ─────────────────────────────────────────────────────────────────────────────

function _getPlayerCharacterInfo() {
    const ctx = getSTContext();
    const s = getSettings();
    let name = '';
    let bio = '';

    if (s.multihogMode && ctx.extensionSettings?.MultihogDnDFramework?.chatStates) {
        const chatId = getChatId();
        const mhState = ctx.extensionSettings.MultihogDnDFramework.chatStates[chatId]?.playerCharacter;
        if (mhState) {
            name = mhState.name || '';
            bio = mhState.bio || '';
        }
    }

    if (!name) name = ctx.name1 || ctx.personas?.[ctx.persona]?.name || 'Player';
    if (!bio)  bio  = ctx.personas?.[ctx.persona]?.description || ctx.persona_description || '';

    const block = `[PLAYER_CHARACTER]\nName: ${name}${bio ? `\n${bio}` : ''}\n[/PLAYER_CHARACTER]`;
    return { pcName: name, pcBio: bio, pcBlock: block };
}

function _getActiveCardInfo() {
    try {
        const ctx = getSTContext();
        const charId = ctx.characterId ?? ctx.this_chid;
        let charData = (charId != null && ctx.characters) ? ctx.characters[charId] : null;
        if (!charData && ctx.characters && ctx.name2) {
            const n2 = String(ctx.name2).toLowerCase().trim();
            charData = Object.values(ctx.characters).find(c => c && String(c.name || '').toLowerCase().trim() === n2) || null;
        }
        if (!charData && !ctx.name2) return null;
        const name = charData?.name || ctx.name2 || '';
        const desc        = (charData?.description || charData?.data?.description || '').trim();
        const scenario    = (charData?.scenario    || charData?.data?.scenario    || '').trim();
        const personality = (charData?.personality || charData?.data?.personality || '').trim();
        const sysPrompt   = (charData?.data?.system_prompt || '').trim();
        const parts = [];
        if (desc)        parts.push(`Description & World Context:\n${desc}`);
        if (scenario)    parts.push(`Scenario & Setting:\n${scenario}`);
        if (personality) parts.push(`Personality & Tone:\n${personality}`);
        if (sysPrompt)   parts.push(`Custom Directives:\n${sysPrompt}`);
        if (!parts.length && !name) return null;
        const cardContent = parts.join('\n\n');
        const cardBlock = `[ACTIVE_CARD_CONTEXT]\nCard: ${name}${cardContent ? `\n${cardContent}` : ''}\n[/ACTIVE_CARD_CONTEXT]`;
        return { cardName: name, cardBlock, cardData: charData };
    } catch (e) {
        console.warn('[SillyPhone] _getActiveCardInfo failed:', e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone activity logger
// ─────────────────────────────────────────────────────────────────────────────

function _logPhoneActivity(type, contact, direction, summary) {
    try {
        const ps = getPhoneState();
        if (!ps) return;
        if (!Array.isArray(ps.phoneHistory)) ps.phoneHistory = [];
        const cleanSummary = _summarizeText(summary, 1000);
        if (!cleanSummary) return;
        // Deduplicate within 4 seconds
        const last = ps.phoneHistory[ps.phoneHistory.length - 1];
        if (last && last.type === type && last.contact === contact && last.summary === cleanSummary && (Date.now() - (last.timestamp || 0) < 4000)) return;
        const timeInfo = getInWorldTimeInfo();
        const ctx = getSTContext();
        const turns = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
        ps.phoneHistory.push({
            timestamp: Date.now(), inWorldMinutes: timeInfo.totalMinutes,
            inWorldTimeStr: timeInfo.clockOnly || timeInfo.rawTime,
            turnNumber: turns, type, contact, direction, summary: cleanSummary,
        });
        // Cap at 500
        if (ps.phoneHistory.length > 500) ps.phoneHistory.splice(0, ps.phoneHistory.length - 500);
        savePhoneState();
    } catch (e) { console.warn('[SillyPhone] _logPhoneActivity failed:', e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene context builder (for app prompts)
// ─────────────────────────────────────────────────────────────────────────────

function _buildSceneContext(overhead = 1200) {
    const ctx = getSTContext();
    const s   = getSettings();
    const contextSize = ctx.contextSize || 8192;
    const { pcName, pcBlock } = _getPlayerCharacterInfo();

    let cardBlockStr = '';
    if (s.includeCardContext !== false) {
        const cardInfo = _getActiveCardInfo();
        if (cardInfo?.cardBlock) cardBlockStr = `${cardInfo.cardBlock}\n\n`;
    }

    const pcBlockStr   = pcBlock ? `${pcBlock}\n\n` : '';
    const staticHeader = `${cardBlockStr}${pcBlockStr}`;
    const dynamicOverhead = overhead + Math.ceil(staticHeader.length / 3.5);
    const charBudget   = Math.floor((contextSize - dynamicOverhead) * 3.5);

    const chat = ctx.chat;
    if (!Array.isArray(chat) || !chat.length) return staticHeader.trim();

    const lines = [];
    let usedChars = staticHeader.length;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        const raw = String(m.mes || m.content || '').trim();
        const text = cleanToolCallMessage(raw);
        if (!text) continue;
        const name = m.is_user ? pcName : (m.name || 'Narrator');
        const line = `${name}: ${text}`;
        if (usedChars + line.length > charBudget) break;
        lines.unshift(line);
        usedChars += line.length + 1;
    }
    const historyBlock = lines.length ? `## RECENT STORY EVENTS\n${lines.join('\n\n')}` : '';
    return `${staticHeader}${historyBlock}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context injection block (injected into AI context on every turn)
// ─────────────────────────────────────────────────────────────────────────────

function buildPhoneContextBlock() {
    try {
        const s = getSettings();
        if (!s.enabled) return '';
        const ps = getPhoneState();
        if (!ps) return '';

        let prefix = 'CRITICAL INSTRUCTION: If the narrative mentions the player put down their phone or closed their computer after X minutes, use the [PHONE/COMPUTER_ACTIVITY] block below to summarize what they were just doing on it.\n';

        const depth = Math.max(1, s.contextDepth || 20);
        const recent = ps.phoneHistory.slice(-depth);
        if (!recent.length && ps.phoneUnread.messages === 0 && ps.phoneUnread.calls === 0) return '';

        const lines = recent.map(e => {
            const when = e.relativeTime || e.inWorldTimeStr || 'recently';
            const dir  = e.direction === 'out' ? '→' : '←';
            return `[${e.type}] ${dir} ${e.contact || ''}: ${e.summary} (${when})`;
        });

        const unreadParts = [];
        if (ps.phoneUnread.messages > 0) unreadParts.push(`${ps.phoneUnread.messages} unread text${ps.phoneUnread.messages > 1 ? 's' : ''}`);
        if (ps.phoneUnread.calls    > 0) unreadParts.push(`${ps.phoneUnread.calls} missed call${ps.phoneUnread.calls > 1 ? 's' : ''}`);
        const unreadNote = unreadParts.length ? `\nPending: ${unreadParts.join(', ')}` : '';

        return `${prefix}[PHONE/COMPUTER_ACTIVITY]\n${lines.join('\n')}${unreadNote}\n[/PHONE/COMPUTER_ACTIVITY]`;
    } catch (e) {
        console.warn('[SillyPhone] buildPhoneContextBlock failed:', e);
        return '';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NPC auto-contact (fires after each AI response)
// ─────────────────────────────────────────────────────────────────────────────

let _npcFiredThisTurn = false;

async function maybeFireNpcContact() {
    try {
        const s = getSettings();
        if (!s.enabled) return;
        if (_npcFiredThisTurn) return;

        const baseChance = s.npcContactChance ?? 8;
        if (baseChance <= 0) return;
        if (Math.random() * 100 >= baseChance) return;

        const ctx = getSTContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];

        // Build recent narrative from last few messages
        const recentMessages = chat.slice(-8).map(m => {
            const raw = String(m.mes || m.content || '').trim();
            return cleanToolCallMessage(raw);
        }).filter(Boolean);
        const combinedNarrative = recentMessages.join('\n\n');
        if (!combinedNarrative) return;

        // Find NPC candidates from contacts and relationship scores
        const ps = getPhoneState();
        if (!ps) return;

        // Use contacts list as candidates, or try to extract NPC names from recent narrative
        const candidates = (ps.phoneContacts || []).map(c => ({ name: c.name, weight: 1.0 }));

        // Boost by lorebook NPC entries if available
        try {
            if (ctx.characters) {
                for (const char of Object.values(ctx.characters)) {
                    if (char?.name && !candidates.find(c => c.name === char.name)) {
                        candidates.push({ name: char.name, weight: 0.5 });
                    }
                }
            }
        } catch (_) {}

        if (!candidates.length) return;

        // Weighted pick
        const totalW = candidates.reduce((t, c) => t + c.weight, 0);
        let rand = Math.random() * totalW;
        let chosen = candidates[0].name;
        for (const c of candidates) {
            rand -= c.weight;
            if (rand <= 0) { chosen = c.name; break; }
        }

        let cardBlockStr = '';
        if (s.includeCardContext !== false) {
            const cardInfo = _getActiveCardInfo();
            if (cardInfo?.cardBlock) cardBlockStr = `${cardInfo.cardBlock}\n\n`;
        }

        const systemPrompt = `You decide if an NPC should contact the player via phone right now. Be realistic and conservative — only say yes when it genuinely fits the current situation. Reply ONLY with valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const userPrompt = `${cardBlockStr}NPC: ${chosen}
Recent story events:
${combinedNarrative.slice(-1500)}

Would ${chosen} realistically reach out to the player right now via phone?
Consider: their relationship, what just happened, urgency, time of day.
Reply ONLY with: {"contact": true, "type": "text"|"call"|"missed_call", "message": "<what they say or null for missed_call>"} or {"contact": false} CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;

        let raw;
        try { raw = await sendPhoneRequest(systemPrompt, userPrompt); } catch { return; }

        let parsed = _parseJsonRobust(raw, null);
        if (!parsed) return;

        if (!parsed.contact) return;

        const timeInfo = getInWorldTimeInfo();
        _logPhoneActivity(parsed.type || 'sms', chosen, 'in', parsed.message || (parsed.type === 'missed_call' ? 'Missed call' : 'Contact event'));

        if (parsed.type === 'text' && parsed.message) {
            if (!ps.phoneMessages[chosen]) ps.phoneMessages[chosen] = [];
            ps.phoneMessages[chosen].push({ text: parsed.message, direction: 'in', timestamp: Date.now(), inWorldMinutes: timeInfo.totalMinutes, inWorldTimeStr: timeInfo.clockOnly });
            ps.phoneUnread.messages = (ps.phoneUnread.messages || 0) + 1;
        } else if (parsed.type === 'missed_call') {
            ps.phoneUnread.calls = (ps.phoneUnread.calls || 0) + 1;
        }

        _npcFiredThisTurn = true;
        savePhoneState();
        _updateNotificationBadge();
        if (_isOpen) _renderCurrentPage();

    } catch (e) { console.warn('[SillyPhone] maybeFireNpcContact error:', e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// NPC context builder for SMS / Calls
// ─────────────────────────────────────────────────────────────────────────────

async function _buildNpcCallContext(contact) {
    const s = getSettings();
    const ctx = getSTContext();
    const { pcName, pcBio, pcBlock } = _getPlayerCharacterInfo();

    // Lorebook NPC lookup + keyword trigger
    let npcBlock = '';
    try {
        if (ctx.loadWorldInfo && contact) {
            const cleanContact = contact.toLowerCase().trim();
            const contactWords = cleanContact.split(/\s+/).filter(Boolean);

            // Gather candidate lorebook names
            const candidateBooks = [];
            try {
                const allBooks = Array.isArray(ctx.world_info) ? ctx.world_info : (await ctx.loadWorldInfoList?.() || []);
                for (const b of allBooks) {
                    if (typeof b === 'string') candidateBooks.push(b);
                }
            } catch (_) {}
            if (!candidateBooks.length) candidateBooks.push('NPCs');

            let matchedEntry = null;
            for (const bookName of candidateBooks) {
                try {
                    const book = await ctx.loadWorldInfo(bookName);
                    if (!book?.entries) continue;
                    for (const [, entry] of Object.entries(book.entries)) {
                        if (!entry?.content) continue;
                        const title = (entry.comment || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
                        const keys  = Array.isArray(entry.key) ? entry.key.map(k => String(k).toLowerCase().trim()) : [];
                        const titleMatch = title === cleanContact || title.includes(cleanContact) || cleanContact.includes(title) || contactWords.some(w => w.length > 2 && title.split(/\s+/).includes(w));
                        const keyMatch   = keys.some(k => k === cleanContact || cleanContact.includes(k) || k.includes(cleanContact));
                        if (titleMatch || keyMatch) { matchedEntry = entry; break; }
                    }
                    if (matchedEntry) break;
                } catch (_) {}
            }
            if (matchedEntry) npcBlock = String(matchedEntry.content).trim();
        }
    } catch (e) { console.warn('[SillyPhone] NPC lore lookup failed:', e); }

    // Fallback to ST character cards
    if (!npcBlock && ctx.characters) {
        try {
            const cleanContact = contact.toLowerCase().trim();
            for (const char of Object.values(ctx.characters)) {
                if (!char?.name) continue;
                const cn = char.name.toLowerCase().trim();
                if (cn === cleanContact || cleanContact.includes(cn) || cn.includes(cleanContact)) {
                    const parts = [];
                    if (char.description) parts.push(`Description:\n${char.description}`);
                    if (char.personality) parts.push(`Personality:\n${char.personality}`);
                    if (char.mes_example) parts.push(`Example Dialogue:\n${char.mes_example}`);
                    npcBlock = parts.join('\n\n');
                    break;
                }
            }
        } catch (_) {}
    }

    // Card context
    let cardBlock = '';
    if (s.includeCardContext !== false) {
        const cardInfo = _getActiveCardInfo();
        if (cardInfo?.cardBlock) cardBlock = cardInfo.cardBlock;
    }

    // Chat history
    const contextSize    = ctx.contextSize || 8192;
    const promptOverhead = 2000 + Math.ceil(((cardBlock?.length || 0) + (npcBlock?.length || 0) + (pcBlock?.length || 0)) / 3.5);
    const charBudget     = Math.floor((contextSize - promptOverhead) * 3.5);

    let chatContext = '';
    const chat = ctx.chat;
    if (Array.isArray(chat) && chat.length) {
        const lines = [];
        let usedChars = 0;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            const text = cleanToolCallMessage(String(m.mes || m.content || '').trim());
            if (!text) continue;
            const name = m.is_user ? pcName : (m.name || 'Narrator');
            const line = `${name}: ${text}`;
            if (usedChars + line.length > charBudget) break;
            lines.unshift(line);
            usedChars += line.length + 1;
        }
        if (lines.length) chatContext = lines.join('\n\n');
    }

    // SMS thread history
    const ps = getPhoneState();
    let threadHistory = '';
    const thread = ps?.phoneMessages?.[contact];
    if (Array.isArray(thread) && thread.length) {
        threadHistory = thread.map(m => {
            const who = m.direction === 'out' ? pcName : contact;
            return `${who}: ${m.text}`;
        }).join('\n');
    }

    return { pcName, pcBio, pcBlock, cardBlock, npcBlock, chatContext, threadHistory };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Runtime State
// ─────────────────────────────────────────────────────────────────────────────

let _phoneEl  = null;
let _isOpen   = false;
let _pageStack = [];
let _currentApp = null;
let _phoneUsedThisTurn = false;

const GENRE_SKIN = { realistic: '', scifi: 'rpg-phone--scifi', horror: 'rpg-phone--horror' };

function _markPhoneUsed() { _phoneUsedThisTurn = true; }

// ─────────────────────────────────────────────────────────────────────────────
// Notification badge
// ─────────────────────────────────────────────────────────────────────────────

function _updateNotificationBadge() {
    try {
        const ps = getPhoneState();
        const total = ps ? (ps.phoneUnread.messages + ps.phoneUnread.calls) : 0;
        const badge = document.getElementById('sillyphone-fab-badge');
        if (!badge) return;
        badge.style.display = total > 0 ? 'flex' : 'none';
        badge.textContent   = total > 9 ? '9+' : String(total);
    } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone open / close / toggle
// ─────────────────────────────────────────────────────────────────────────────

let _phoneSessionStartTime = 0;
let _phoneActiveTimeMs = 0;
let _phoneLastActivityTime = 0;
const IDLE_TIMEOUT_MS = 60000;

function _recordPhoneActivity() {
    if (!_isOpen) return;
    const now = Date.now();
    const delta = now - _phoneLastActivityTime;
    
    // Accumulate time in persistent state
    const ps = getPhoneState();
    if (ps) {
        ps.phoneActiveTimeMs = (ps.phoneActiveTimeMs || 0) + Math.min(delta, IDLE_TIMEOUT_MS);
        savePhoneState();
    }
    
    _phoneLastActivityTime = now;
}

function openPhone() {
    if (!_phoneEl) _buildPhonePanel();
    _isOpen = true;
    _phoneSessionStartTime = Date.now();
    _phoneLastActivityTime = Date.now();
    
    const s = getSettings();
    const shell = _phoneEl.querySelector('.rpg-phone-shell');
    
    // Clear previously hardcoded dimension overrides
    _phoneEl.style.width = '';
    _phoneEl.style.height = '';
    shell.style.width = '';
    shell.style.height = '';
    _phoneEl.querySelector('.rpg-phone-screen').style.fontSize = '';

    let finalScale = 1;
    if (globalThis._rpgLaptopMode) {
        _phoneEl.dataset.device = 'laptop';
        finalScale = (s.laptopScale || 100) / 100;
        shell.style.transform = `scale(${finalScale})`;
        shell.style.transformOrigin = 'center center';
    } else {
        delete _phoneEl.dataset.device;
        finalScale = (s.phoneScale || 100) / 100;
        if (s.phoneMode) finalScale *= 0.85; // Mobile layout support
        shell.style.transform = `scale(${finalScale})`;
        shell.style.transformOrigin = 'center center';
    }
    
    _phoneEl.style.display = 'flex';
    _applyGenreSkin();
    _restorePanelPosition();
    _updateStatusBar();
    _navigateHome();
    
    // Update put down button text and position
    const btn = _phoneEl.querySelector('#rpg_phone_putdown_btn');
    if (btn) {
        btn.innerHTML = globalThis._rpgLaptopMode ? '💻 Close computer' : '📱 Put down phone';
        const h = shell.offsetHeight || 812;
        btn.style.top = `calc(50% - ${(h * finalScale / 2) + 40}px)`;
    }
}

function closePhone() {
    if (!_isOpen) return;
    _recordPhoneActivity(); // flush final delta
    _isOpen = false;
    if (_phoneEl) _phoneEl.style.display = 'none';
}

function togglePhone() {
    _isOpen ? closePhone() : openPhone();
}

// ─────────────────────────────────────────────────────────────────────────────
// Draggable helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Makes an element draggable.
 * onDragEnd is called with (left, top, wasDragged).
 * wasDragged is true only if the pointer moved more than DRAG_THRESHOLD px.
 * Returns false from onDragEnd when it was just a click — caller can use this
 * to distinguish a click from a real drag.
 */
const DRAG_THRESHOLD = 12; // pixels — higher for mobile touch tolerance
function _makeDraggable(el, handleEl, onDragEnd) {
    let x0 = 0, y0 = 0, startL = 0, startT = 0, moved = false, startTime = 0;

    handleEl.addEventListener('mousedown', startDrag);
    handleEl.addEventListener('touchstart', e => { e.preventDefault(); startDrag(e.touches[0]); }, { passive: false });

    function startDrag(e) {
        x0 = e.clientX; y0 = e.clientY;
        moved = false;
        startTime = Date.now();
        const rect = el.getBoundingClientRect();
        startL = rect.left; startT = rect.top;

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        document.addEventListener('touchmove',  onTouchMove, { passive: false });
        document.addEventListener('touchend',   onTouchEnd);
    }
    function onTouchMove(e) { e.preventDefault(); onMove(e.touches[0]); }
    function onMove(e) {
        const dx = e.clientX - x0;
        const dy = e.clientY - y0;
        // Only start actually moving after threshold — avoids accidental drags on click
        if (!moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        if (!moved) {
            // Commit position now that we know it's a real drag
            moved = true;
            el.style.transform = 'none';
            el.style.left = startL + 'px';
            el.style.top  = startT + 'px';
        }
        el.style.left = (startL + dx) + 'px';
        el.style.top  = (startT + dy) + 'px';
    }
    function onTouchEnd(e) {
        // On mobile, treat short taps (< 300ms, < 15px total movement) as clicks not drags
        const elapsed = Date.now() - startTime;
        const touch = e.changedTouches?.[0];
        let dist = 0;
        if (touch) dist = Math.sqrt((touch.clientX - x0) ** 2 + (touch.clientY - y0) ** 2);
        if (elapsed < 300 && dist < 15) moved = false;
        onUp();
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('touchmove',  onTouchMove);
        document.removeEventListener('touchend',   onTouchEnd);
        if (onDragEnd) onDragEnd(el.style.left, el.style.top, moved);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone panel construction
// ─────────────────────────────────────────────────────────────────────────────

function _buildPhonePanel() {
    if (_phoneEl) return;

    _phoneEl = document.createElement('div');
    _phoneEl.className = 'rpg-phone';
    _phoneEl.id = 'sillyphone_panel';
    _phoneEl.style.display = 'none';
    _phoneEl.style.position = 'fixed';
    
    const putDownBtn = `
    <div id="rpg_phone_putdown_btn" style="position:absolute; top:-40px; left:50%; transform:translateX(-50%); background:rgba(255,255,255,0.1); backdrop-filter:blur(10px); color:white; padding:8px 16px; border-radius:20px; font-weight:bold; cursor:pointer; font-size:13px; box-shadow:0 4px 12px rgba(0,0,0,0.5); z-index:100; border:1px solid rgba(255,255,255,0.2); white-space:nowrap; pointer-events:all; user-select:none;">
      ⬇️ Put down phone
    </div>`;

    _phoneEl.innerHTML = putDownBtn + _phoneShellHTML();

    document.body.appendChild(_phoneEl);
    
    ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(evt => {
        _phoneEl.addEventListener(evt, _recordPhoneActivity, { passive: true });
    });
    
    _phoneEl.querySelector('#rpg_phone_putdown_btn')?.addEventListener('click', () => {
        const s = getSettings();
        if (s.autoPutDownMessage !== false) {
            _recordPhoneActivity(); // ensure final time is captured
            const ps = getPhoneState();
            const totalMs = ps ? (ps.phoneActiveTimeMs || 0) : 0;
            const minutes = Math.max(1, Math.round(totalMs / 60000));
            const deviceName = globalThis._rpgLaptopMode ? 'computer' : 'phone';
            const action = globalThis._rpgLaptopMode ? 'closed' : 'put down';
            const msg = `You ${action} the ${deviceName} after using it for ${minutes} minute${minutes > 1 ? 's' : ''}.`;
            
            // Reset active time since they intentionally put it down
            if (ps) {
                ps.phoneActiveTimeMs = 0;
                savePhoneState();
            }
            
            if (s.putDownMessageToTextbox) {
                const ta = document.getElementById('send_textarea');
                if (ta) {
                    ta.value = ta.value ? ta.value + '\n' + msg : msg;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else {
                const ctx = getSTContext();
                if (ctx.executeSlashCommandsWithOptions) {
                    ctx.executeSlashCommandsWithOptions(`/send ${msg}`);
                }
            }
        }
        closePhone();
    });

    _phoneEl.querySelector('#rpg_phone_close_btn')?.addEventListener('click', closePhone);
    _phoneEl.querySelector('#rpg_phone_back_btn')?.addEventListener('click', _navigateBack);
    _phoneEl.querySelector('#rpg_phone_refresh_btn')?.addEventListener('click', () => {
        if (typeof globalThis._rpgPhoneRefreshCb === 'function') globalThis._rpgPhoneRefreshCb();
    });
    _phoneEl.querySelector('#rpg_phone_home_btn')?.addEventListener('click', _navigateHome);

    // Make phone shell draggable by the statusbar
    const shell     = _phoneEl.querySelector('.rpg-phone-shell');
    const statusbar = _phoneEl.querySelector('.rpg-phone-statusbar');
    if (shell && statusbar) {
        statusbar.classList.add('rpg-phone-drag-handle');
        _makeDraggable(_phoneEl, statusbar, (left, top) => {
            const s = getSettings();
            s.panelX = left; s.panelY = top;
            saveSettings();
        });
    }

    // Dock buttons
    _phoneEl.querySelectorAll('.rpg-phone-dock-btn').forEach(btn => {
        btn.addEventListener('click', () => { if (_isOpen) _navigateTo(btn.dataset.app); });
    });

    setInterval(_updateStatusBar, 60000);
}

function _phoneShellHTML() {
    const s = getSettings();
    const scaleStyle = s.phoneMode ? 'transform: scale(0.85); transform-origin: center center;' : '';
    return `
<div class="rpg-phone-shell" style="${scaleStyle}">
  <div class="rpg-phone-notch"></div>
  <div class="rpg-phone-statusbar" id="rpg_phone_statusbar">
    <span class="rpg-phone-time" id="rpg_phone_time">12:00</span>
    <div class="rpg-phone-statusbar-icons">
      <span class="rpg-phone-signal">▐▐▐</span>
      <span class="rpg-phone-battery" id="rpg_phone_battery">🔋</span>
    </div>
  </div>

  <div class="rpg-phone-navbar" id="rpg_phone_navbar">
    <button class="rpg-phone-nav-btn" id="rpg_phone_back_btn" title="Back">‹</button>
    <span class="rpg-phone-nav-title" id="rpg_phone_nav_title"></span>
    <button class="rpg-phone-nav-btn" id="rpg_phone_batch_gen_btn" title="Batch Generate Images" style="display:none;font-size:16px;padding-top:2px">🎨</button>
    <button class="rpg-phone-nav-btn" id="rpg_phone_refresh_btn" title="Refresh" style="display:none;font-size:16px;padding-top:2px">↻</button>
    <button class="rpg-phone-nav-btn rpg-phone-close-btn" id="rpg_phone_close_btn" title="Close phone">✕</button>
  </div>

  <div class="rpg-phone-screen" id="rpg_phone_screen">
    <!-- Dynamic content rendered here -->
  </div>

  <div class="rpg-phone-dock">
    <button class="rpg-phone-dock-btn" data-app="dialer"   title="Phone">📞</button>
    <button class="rpg-phone-dock-btn" data-app="messages" title="Messages">💬</button>
    <button class="rpg-phone-home-btn" id="rpg_phone_home_btn" title="Home">⚪</button>
    <button class="rpg-phone-dock-btn" data-app="camera"   title="Camera">📷</button>
    <button class="rpg-phone-dock-btn" data-app="contacts" title="Contacts">👥</button>
  </div>
</div>
`;
}

function _applyGenreSkin() {
    if (!_phoneEl) return;
    const ctx = getSTContext();
    const genre = ctx.extensionSettings?.MultihogDnDFramework?.onboardingGenre
        || ctx.extensionSettings?.SillyPhone?.genre
        || 'realistic';
    _phoneEl.classList.remove('rpg-phone--scifi', 'rpg-phone--horror');
    const skin = GENRE_SKIN[genre];
    if (skin) _phoneEl.classList.add(skin);
}

function _restorePanelPosition() {
    const s = getSettings();
    if (!_phoneEl) return;
    
    if (s.phoneMode) {
        // On mobile, always center the phone panel on screen
        _phoneEl.style.transform = 'translate(-50%, -50%)';
        _phoneEl.style.left = '50%';
        _phoneEl.style.top  = '50%';
    } else if (s.panelX && s.panelY) {
        _phoneEl.style.transform = 'none';
        _phoneEl.style.left = s.panelX;
        _phoneEl.style.top  = s.panelY;
    } else {
        _phoneEl.style.transform = 'translate(-50%, -50%)';
        _phoneEl.style.left = '50%';
        _phoneEl.style.top  = '50%';
    }
}

function _updateStatusBar() {
    if (!_phoneEl) return;
    const timeEl = _phoneEl.querySelector('#rpg_phone_time');
    if (timeEl) timeEl.textContent = getInWorldTimeInfo().clockOnly;
}

function _updateRelativeTimes() {
    try {
        const ps = getPhoneState();
        if (!ps || !Array.isArray(ps.phoneHistory)) return;
        const currentInfo  = getInWorldTimeInfo();
        const currentMins  = currentInfo.totalMinutes;
        const ctx          = getSTContext();
        const currentTurns = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
        for (const e of ps.phoneHistory) {
            if (e.inWorldMinutes != null && currentMins != null) {
                const diffM = currentMins - e.inWorldMinutes;
                if (diffM <= 0)          e.relativeTime = 'just now';
                else if (diffM < 60)     e.relativeTime = `${diffM}m ago`;
                else if (diffM < 1440)   { const h = Math.floor(diffM/60), m = diffM%60; e.relativeTime = m > 0 ? `${h}h ${m}m ago` : `${h}h ago`; }
                else                     { const days = Math.floor(diffM/1440); e.relativeTime = days === 1 ? '1 day ago' : `${days}d ago`; }
            } else if (e.turnNumber != null) {
                const d = currentTurns - e.turnNumber;
                e.relativeTime = d <= 0 ? 'just now' : d === 1 ? '1 turn ago' : `${d} turns ago`;
            } else {
                e.relativeTime = e.inWorldTimeStr ? `at ${e.inWorldTimeStr}` : 'just now';
            }
        }
    } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

function _navigateHome() {
    _pageStack = []; _currentApp = null;
    _setNavTitle(''); _setBackVisible(false);
    _renderHomeScreen();
}

function _navigateTo(appId, pageId = 'home', params = {}) {
    _pageStack.push({ appId, pageId, params });
    _currentApp = appId;
    _setBackVisible(true);
    _renderPage(appId, pageId, params);
}

function _navigateBack() {
    if (_pageStack.length <= 1) { _navigateHome(); return; }
    _pageStack.pop();
    const prev = _pageStack[_pageStack.length - 1];
    _currentApp = prev.appId;
    _renderPage(prev.appId, prev.pageId, prev.params);
    if (_pageStack.length <= 1) _setBackVisible(false);
}

function _renderCurrentPage() {
    if (!_pageStack.length) { _renderHomeScreen(); return; }
    const cur = _pageStack[_pageStack.length - 1];
    _renderPage(cur.appId, cur.pageId, cur.params);
}

function _setNavTitle(title) {
    const el = _phoneEl?.querySelector('#rpg_phone_nav_title');
    if (el) el.textContent = title;
}

function _setBackVisible(vis) {
    const btn = _phoneEl?.querySelector('#rpg_phone_back_btn');
    if (btn) btn.style.visibility = vis ? 'visible' : 'hidden';
}

function _setRefreshAction(cb) {
    const btn = _phoneEl?.querySelector('#rpg_phone_refresh_btn');
    if (btn) {
        btn.style.display = typeof cb === 'function' ? 'block' : 'none';
        globalThis._rpgPhoneRefreshCb = cb;
    }
}

function _getScreen() {
    return _phoneEl?.querySelector('#rpg_phone_screen');
}

// ─────────────────────────────────────────────────────────────────────────────
// Home Screen
// ─────────────────────────────────────────────────────────────────────────────

function _renderHomeScreen() {
    const screen = _getScreen();
    if (!screen) return;
    const ps = getPhoneState();
    const unread = ps?.phoneUnread || { messages: 0, calls: 0 };
    const msgBadge  = unread.messages > 0 ? `<span class="rpg-phone-app-badge">${unread.messages}</span>` : '';
    const callBadge = unread.calls    > 0 ? `<span class="rpg-phone-app-badge">${unread.calls}</span>`   : '';
    const builtinApps = [
        { id: 'google', icon: 'https://www.google.com/images/branding/googleg/1x/googleg_standard_color_128dp.png', label: 'Google' },
        { id: 'reddit', icon: 'https://www.redditstatic.com/desktop2x/img/favicon/apple-icon-180x180.png', label: 'Reddit' },
        { id: 'appstore',  icon: '🏪', label: 'App Store' },
        { id: 'messages',  icon: '💬', label: 'Messages', badge: msgBadge  },
        { id: 'dialer',    icon: '📞', label: 'Phone',    badge: callBadge },
        { id: 'contacts',  icon: '👥', label: 'Contacts'  },
        { id: 'camera',    icon: '📷', label: 'Camera'    },
        { id: 'gallery',   icon: '🖼️', label: 'Gallery'   },
        { id: 'settings',  icon: '⚙️', label: 'Settings'  },
    ];
    const installedApps = (ps?.phoneApps || []).map(app => ({ id: `installed_${app.id}`, icon: app.icon || '📱', label: app.name, installed: true }));
    const allApps = [...builtinApps, ...installedApps];
    const iconsHTML = allApps.map(app => {
        const isImg = app.icon && (app.icon.trim().startsWith('http') || app.icon.trim().startsWith('data:image') || app.icon.trim().startsWith('/'));
        const bgStyle = isImg ? 'background:transparent; border:none; box-shadow:none;' : '';
        return `
<div class="rpg-phone-app-icon" data-app="${app.id}" role="button" tabindex="0" aria-label="${app.label}">
  <div class="rpg-phone-app-icon-img" style="${bgStyle}">${_renderIcon(app.icon)}${app.badge || ''}</div>
  <div class="rpg-phone-app-icon-label">${app.label}</div>
</div>`;
    }).join('');
    screen.innerHTML = `<div class="rpg-phone-homescreen">${iconsHTML}</div>`;
    screen.querySelectorAll('.rpg-phone-app-icon').forEach(el => {
        el.addEventListener('click', () => _navigateTo(el.dataset.app));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Image parsing & click-to-generate
// ─────────────────────────────────────────────────────────────────────────────

function _parsePhoneImages(text) {
    if (!text) return '';
    const ps = getPhoneState();
    return text.replace(/\[IMAGE:\s*([\s\S]*?)\]/gi, (match, desc) => {
        const cleanDesc = desc.trim();
        if (ps.phoneImageCache && ps.phoneImageCache[cleanDesc]) {
            return `<img class="rpg-phone-generated-image" data-img-prompt="${_escHtml(cleanDesc)}" src="${_escHtml(ps.phoneImageCache[cleanDesc])}" style="width:100%;border-radius:8px;cursor:pointer;display:block;margin-bottom:8px;" />`;
        }
        return `<div class="rpg-phone-image-placeholder" data-img-prompt="${_escHtml(cleanDesc)}" role="button" tabindex="0">
            <div class="rpg-phone-image-prompt" style="font-size:11px;color:rgba(255,255,255,0.7);margin-bottom:8px;font-style:italic;">"${_escHtml(cleanDesc)}"</div>
            <span>🖼️ Click to generate image</span>
        </div>`;
    });
}

function _showPhoneImagePopup(desc, onResult) {
    const s = getSettings();
    const overlay = document.createElement('div');
    overlay.className = 'rpg-phone-popup-overlay';
    overlay.innerHTML = `
        <div class="rpg-phone-popup" style="font-family: system-ui, -apple-system, sans-serif;">
            <h4 style="margin:0 0 8px 0;font-size:16px;">Image Generation</h4>
            <p style="font-size:12px;margin:0 0 12px 0;color:rgba(255,255,255,0.7);">Edit the prompt before generating, or upload an image.</p>
            <textarea id="rph_img_popup_prompt" rows="4" style="width:100%;margin-bottom:12px;background:var(--SmartThemeDarkerColor, #121212);color:var(--SmartThemeBodyColor, #fff);border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:8px;box-sizing:border-box;">${_escHtml(desc)}</textarea>
            
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">
                <label style="font-size:12px;color:rgba(255,255,255,0.7);">Slash Command:</label>
                <input type="text" id="rph_img_popup_cmd" style="width:100%;background:var(--SmartThemeDarkerColor, #121212);color:var(--SmartThemeBodyColor, #fff);border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px;box-sizing:border-box;" value="${_escHtml(s.imageGenCommand || '/imagine quiet=true "{{prompt}}"')}"/>
            </div>

            <div style="display:flex;flex-direction:column;gap:8px;">
                <button class="rpg-phone-reddit-btn primary" id="rph_img_popup_gen" style="justify-content:center;padding:8px;font-weight:bold;">✨ Generate</button>
                <div style="position:relative;width:100%;">
                    <button class="rpg-phone-reddit-btn" style="width:100%;justify-content:center;padding:8px;">📁 Upload Image</button>
                    <input type="file" id="rph_img_popup_upload" accept="image/*" style="opacity:0;position:absolute;top:0;left:0;width:100%;height:100%;cursor:pointer;"/>
                </div>
                <button class="rpg-phone-reddit-btn" id="rph_img_popup_cancel" style="justify-content:center;padding:8px;margin-top:4px;">Cancel</button>
            </div>
        </div>
    `;
    const container = document.body;
    container.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('rph_img_popup_cancel').onclick = close;
    
    document.getElementById('rph_img_popup_gen').onclick = () => {
        const finalDesc = document.getElementById('rph_img_popup_prompt').value.trim();
        const finalCmd = document.getElementById('rph_img_popup_cmd').value.trim();
        if (finalCmd !== s.imageGenCommand) {
            s.imageGenCommand = finalCmd;
            saveSettings();
        }
        close();
        if (finalDesc) onResult({ type: 'generate', desc: finalDesc, cmd: finalCmd });
    };

    const uploadIn = document.getElementById('rph_img_popup_upload');
    uploadIn.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (re) => {
            close();
            onResult({ type: 'upload', dataUrl: re.target.result });
        };
        reader.readAsDataURL(file);
    });
}

function _showPhoneImageViewerPopup(src, desc, onEdit, onRegenerate) {
    _logPhoneActivity('image', 'Image', 'in', 'Viewed full-size image: ' + _summarizeText(desc || 'photo', 50));
    const overlay = document.createElement('div');
    overlay.className = 'rpg-phone-popup-overlay';
    overlay.innerHTML = `
        <div class="rpg-phone-popup" style="font-family: system-ui, -apple-system, sans-serif; text-align:center; width: auto; max-width: 95vw; max-height: 95vh; overflow: auto;">
            <img src="${_escHtml(src)}" style="border-radius:8px;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto;" />
            <div style="display:flex;gap:8px;justify-content:center;">
                <button class="rpg-phone-reddit-btn primary" id="rph_img_view_regen" style="flex:1;justify-content:center;padding:8px;">Regenerate</button>
                <button class="rpg-phone-reddit-btn" id="rph_img_view_edit" style="flex:1;justify-content:center;padding:8px;">Edit Prompt</button>
            </div>
            <button class="rpg-phone-reddit-btn" id="rph_img_view_cancel" style="width:100%;justify-content:center;padding:8px;margin-top:8px;">Close</button>
        </div>
    `;
    const container = document.body;
    container.appendChild(overlay);
    
    const close = () => overlay.remove();
    document.getElementById('rph_img_view_cancel').onclick = close;
    document.getElementById('rph_img_view_regen').onclick = () => { close(); onRegenerate(); };
    document.getElementById('rph_img_view_edit').onclick = () => { close(); onEdit(); };
}

function _bindPhoneImages(screen) {
    if (!screen) return;

    const bindViewer = (imgEl, desc, src) => {
        if (imgEl._hasViewerListener) return;
        imgEl._hasViewerListener = true;
        imgEl.addEventListener('click', (e) => {
            e.stopPropagation();
            _showPhoneImageViewerPopup(src, desc, 
                () => {
                    _showPhoneImagePopup(desc, (result) => _handleImageResult(result, imgEl, desc));
                },
                () => {
                    const s = getSettings();
                    const cmd = s.imageGenCommand || '/imagine quiet=true "{{prompt}}"';
                    _handleImageResult({ type: 'generate', desc: desc, cmd: cmd }, imgEl, desc);
                }
            );
        });
    };

    const _handleImageResult = async (result, el, desc) => {
        if (result.type === 'upload') {
            const ps = getPhoneState();
            if (!ps.phoneImageCache) ps.phoneImageCache = {};
            ps.phoneImageCache[desc] = result.dataUrl;
            savePhoneState();
            
            const img = document.createElement('img');
            img.src = result.dataUrl;
            img.className = 'rpg-phone-generated-image';
            img.dataset.imgPrompt = desc;
            img.style.cssText = 'width:100%;border-radius:8px;cursor:pointer;display:block;margin-bottom:8px;';
            el.replaceWith(img);
            bindViewer(img, desc, result.dataUrl);
        } else if (result.type === 'generate') {
            const wrapper = document.createElement('div');
            wrapper.className = 'rpg-phone-image-placeholder';
            wrapper.dataset.generating = 'true';
            wrapper.innerHTML = '<span>⏳ Generating image…</span>';
            el.replaceWith(wrapper);
            
            try {
                const ctx = getSTContext();
                if (ctx.executeSlashCommandsWithOptions) {
                    const escapedPrompt = result.desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const cmd = result.cmd.replace('{{prompt}}', escapedPrompt);
                    const res = await ctx.executeSlashCommandsWithOptions(cmd);
                    if (res?.pipe) {
                        let finalSrc = res.pipe;
                        if (finalSrc.startsWith('blob:')) {
                            try {
                                const fetched = await fetch(finalSrc);
                                const blob = await fetched.blob();
                                finalSrc = await new Promise(r => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => r(reader.result);
                                    reader.readAsDataURL(blob);
                                });
                            } catch(e) { console.warn('[SillyPhone] Blob conversion failed', e); }
                        }
                        const ps = getPhoneState();
                        if (!ps.phoneImageCache) ps.phoneImageCache = {};
                        ps.phoneImageCache[desc] = finalSrc;
                        savePhoneState();
                        
                        const img = document.createElement('img');
                        img.src = finalSrc;
                        img.className = 'rpg-phone-generated-image';
                        img.dataset.imgPrompt = desc;
                        img.style.cssText = 'width:100%;border-radius:8px;cursor:pointer;display:block;margin-bottom:8px;';
                        wrapper.replaceWith(img);
                        bindViewer(img, desc, finalSrc);
                        return;
                    }
                }
                wrapper.dataset.generating = '';
                wrapper.innerHTML = '<span style="color:#ff6b6b">Image generation not available.</span>';
                wrapper.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _showPhoneImagePopup(desc, (r) => _handleImageResult(r, wrapper, desc));
                });
            } catch (err) {
                wrapper.dataset.generating = '';
                wrapper.innerHTML = `<span style="color:#ff6b6b">❌ ${_escHtml(err.message || String(err))}</span>`;
                wrapper.addEventListener('click', (e) => {
                    e.stopPropagation();
                    _showPhoneImagePopup(desc, (r) => _handleImageResult(r, wrapper, desc));
                });
            }
        }
    };

    screen.querySelectorAll('.rpg-phone-image-placeholder').forEach(el => {
        if (el._hasImgListener) return;
        el._hasImgListener = true;
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (el.dataset.generating === 'true') return;
            const desc = el.dataset.imgPrompt;
            if (!desc) return;
            _showPhoneImagePopup(desc, (result) => _handleImageResult(result, el, desc));
        });
    });

    screen.querySelectorAll('.rpg-phone-generated-image').forEach(el => {
        const desc = el.dataset.imgPrompt;
        if (desc) bindViewer(el, desc, el.src);
    });

    // Batch generate logic
    const placeholders = Array.from(screen.querySelectorAll('.rpg-phone-image-placeholder:not([data-generating="true"])'));
    const batchBtn = _phoneEl?.querySelector('#rpg_phone_batch_gen_btn');
    if (batchBtn) {
        if (placeholders.length > 0) {
            batchBtn.style.display = 'block';
            batchBtn.onclick = async () => {
                if (batchBtn.dataset.busy === 'true') return;
                batchBtn.dataset.busy = 'true';
                batchBtn.style.opacity = '0.5';
                for (const el of placeholders) {
                    if (!el.isConnected || el.dataset.generating === 'true') continue;
                    const desc = el.dataset.imgPrompt;
                    if (!desc) continue;
                    const s = getSettings();
                    const cmd = s.imageGenCommand || '/imagine quiet=true "{{prompt}}"';
                    await _handleImageResult({ type: 'generate', desc: desc, cmd: cmd }, el, desc);
                }
                batchBtn.dataset.busy = 'false';
                batchBtn.style.opacity = '1';
                batchBtn.style.display = 'none';
            };
        } else {
            batchBtn.style.display = 'none';
            batchBtn.onclick = null;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page router
// ─────────────────────────────────────────────────────────────────────────────

function _renderPage(appId, pageId, params) {
    const screen = _getScreen();
    if (!screen) return;
    _setRefreshAction(null);
    const batchBtn = _phoneEl?.querySelector('#rpg_phone_batch_gen_btn');
    if (batchBtn) {
        batchBtn.style.display = 'none';
        batchBtn.onclick = null;
    }
    screen.innerHTML = `<div class="rpg-phone-loading"><div class="rpg-phone-spinner"></div><p>Loading…</p></div>`;
    switch (appId) {
        case 'google':   return _renderGoogleApp(pageId, params, screen);
        case 'reddit':   return _renderRedditApp(pageId, params, screen);
        case 'appstore': return _renderAppStoreApp(pageId, params, screen);
        case 'messages': return _renderMessagesApp(pageId, params, screen);
        case 'dialer':   return _renderDialerApp(pageId, params, screen);
        case 'contacts': return _renderContactsApp(pageId, params, screen);
        case 'camera':   return _renderCameraApp(pageId, params, screen);
        case 'gallery':  return _renderGalleryApp(pageId, params, screen);
        case 'settings': return _renderPhoneSettingsApp(pageId, params, screen);
        default:
            if (appId.startsWith('installed_')) return _renderInstalledApp(appId.replace('installed_', ''), pageId, params, screen);
            screen.innerHTML = `<div class="rpg-phone-error">App not found.</div>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderGoogleApp(pageId, params, screen) {
    _setNavTitle('Google');

    if (pageId === 'home' || !pageId) {
        screen.innerHTML = `
<div class="rpg-phone-google-home">
  <div class="rpg-phone-google-logo">Google</div>
  <div class="rpg-phone-search-bar-wrap">
    <input type="text" class="rpg-phone-search-input" id="rpg_phone_google_input" placeholder="Search…" autocomplete="off"/>
    <button class="rpg-phone-search-btn" id="rpg_phone_google_search_btn">🔍</button>
  </div>
  <button class="rpg-phone-feeling-lucky" id="rpg_phone_lucky_btn">I'm Feeling Lucky</button>
</div>`;
        const doSearch = () => {
            const q = document.getElementById('rpg_phone_google_input')?.value?.trim();
            if (q) _navigateTo('google', 'results', { query: q });
        };
        document.getElementById('rpg_phone_google_search_btn')?.addEventListener('click', doSearch);
        document.getElementById('rpg_phone_google_input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        document.getElementById('rpg_phone_lucky_btn')?.addEventListener('click', () => {
            const q = document.getElementById('rpg_phone_google_input')?.value?.trim() || 'something interesting';
            _navigateTo('google', 'lucky', { query: q });
        });
        _logPhoneActivity('web', 'Google', 'out', 'Opened Google Search');
        return;
    }

    if (pageId === 'results') {
        const query = params.query || '';
        _setNavTitle(`"${query}"`);
        _logPhoneActivity('web', 'Google', 'out', `Searched: "${query}"`);

        const ps = getPhoneState();
        const cacheKey = `google_results_${query}`;
        if (ps.phoneCache[cacheKey]) {
            _renderGoogleResults(screen, query, ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderGoogleApp('results', params, screen); });
            return;
        }

        const sceneCtx = _buildSceneContext(1200);
        const sys = `You simulate Google search results in this fictional narrative world. Reply ONLY with valid JSON array — no markdown, no explanation. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const usr = `${sceneCtx}\n\nGenerate 5 realistic Google search results for the query: "${query}"\nJSON: [{"url":"","title":"","snippet":""}]`;
        try {
            const raw = await sendPhoneRequest(sys, usr);
            const results = _parseJsonRobust(raw, []);
            ps.phoneCache[cacheKey] = results;
            savePhoneState();
            _renderGoogleResults(screen, query, results);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderGoogleApp('results', params, screen); });
        } catch (e) {
            screen.innerHTML = `<div class="rpg-phone-error">Search failed: ${_escHtml(e.message)}</div>`;
        }
        return;
    }

    if (pageId === 'lucky' || pageId === 'webpage') {
        const query = params.query || params.url || '';
        const url   = params.url   || query;
        _setNavTitle(url);
        _logPhoneActivity('web', url, 'out', `Visited: ${url}`);

        const ps = getPhoneState();
        const cacheKey = `google_page_${url}`;
        if (ps.phoneCache[cacheKey]) {
            _renderWebpage(screen, url, ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderGoogleApp(pageId, params, screen); });
            return;
        }

        const sceneCtx = _buildSceneContext(1500);
        const sys = `You write a fictional webpage that exists in this narrative world. Write 2–3 paragraphs of realistic content — no meta commentary.`;
        const usr = `${sceneCtx}\n\nWrite the content for this webpage: "${url || query}"`;
        try {
            const html = await sendPhoneRequest(sys, usr);
            ps.phoneCache[cacheKey] = html;
            savePhoneState();
            _renderWebpage(screen, url, html);
            _logPhoneActivity('web', url, 'in', `Read webpage: ${_summarizeText(html, 100)}`);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderGoogleApp(pageId, params, screen); });
        } catch (e) {
            screen.innerHTML = `<div class="rpg-phone-error">Failed to load page: ${_escHtml(e.message)}</div>`;
        }
    }
}

function _renderGoogleResults(screen, query, results) {
    const resultsHTML = results.map(r => `
<div class="rpg-phone-search-result" data-url="${_escHtml(r.url || query)}">
  <div class="rpg-phone-result-url">${_escHtml(r.url || '')}</div>
  <div class="rpg-phone-result-title">${_escHtml(r.title || '')}</div>
  <div class="rpg-phone-result-snippet">${_escHtml(r.snippet || '')}</div>
</div>`).join('');
    screen.innerHTML = `
<div class="rpg-phone-results-header">
  <div class="rpg-phone-results-query">Results for: "${_escHtml(query)}"</div>
</div>
<div class="rpg-phone-results-list">${resultsHTML}</div>`;
    screen.querySelectorAll('.rpg-phone-search-result').forEach(el => {
        el.addEventListener('click', () => _navigateTo('google', 'webpage', { url: el.dataset.url, query }));
    });
}

function _renderWebpage(screen, url, content) {
    screen.innerHTML = `
<div class="rpg-phone-webpage">
  <div class="rpg-phone-webpage-urlbar">${_escHtml(url)}</div>
  <div class="rpg-phone-webpage-content">${_escHtml(content)}</div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REDDIT APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderRedditApp(pageId, params, screen) {
    _setNavTitle('Reddit');
    const ps = getPhoneState();

    const renderTabs = (activeTab) => `
<div class="rpg-phone-reddit-tabs" style="overflow-x: auto; flex-wrap: nowrap;">
  <button class="rpg-phone-reddit-tab ${activeTab === 'foryou' ? 'active' : ''}" data-tab="foryou" style="white-space: nowrap; padding: 10px 8px;">For You</button>
  <button class="rpg-phone-reddit-tab ${activeTab === 'feed' ? 'active' : ''}" data-tab="feed" style="white-space: nowrap; padding: 10px 8px;">Feed</button>
  <button class="rpg-phone-reddit-tab ${activeTab === 'discover' ? 'active' : ''}" data-tab="discover" style="white-space: nowrap; padding: 10px 8px;">Discover</button>
  <button class="rpg-phone-reddit-tab ${activeTab === 'joined' ? 'active' : ''}" data-tab="joined" style="white-space: nowrap; padding: 10px 8px;">Joined</button>
  <button class="rpg-phone-reddit-tab ${activeTab === 'dms' ? 'active' : ''}" data-tab="dms" style="white-space: nowrap; padding: 10px 8px;">Chats</button>
  <button class="rpg-phone-reddit-tab ${activeTab === 'saved' ? 'active' : ''}" data-tab="saved" style="white-space: nowrap; padding: 10px 8px;">Saved</button>
</div>`;

    const bindTabs = () => {
        screen.querySelectorAll('.rpg-phone-reddit-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                if (tab === 'foryou') _navigateTo('reddit', 'home');
                else if (tab === 'feed') _navigateTo('reddit', 'feed');
                else if (tab === 'discover') _navigateTo('reddit', 'discover');
                else if (tab === 'joined') _navigateTo('reddit', 'joined_subs');
                else if (tab === 'dms') _navigateTo('reddit', 'dm_list');
                else if (tab === 'saved') _navigateTo('reddit', 'saved');
            });
        });
    };

    const _injectSearchBar = (header, sourcePageId) => {
        if (!header) return;
        const searchHtml = `
        <div class="rpg-phone-reddit-search">
          <input type="text" class="rpg-phone-input-small" id="rph_reddit_search_input" placeholder="Search subreddits..." style="flex:1" autocomplete="off"/>
          <button class="rpg-phone-reddit-btn primary" id="rph_reddit_search_btn" title="Search">🔍</button>
          <button class="rpg-phone-reddit-btn" id="rph_reddit_go_btn" title="Go directly to sub">Go</button>
        </div>`;
        header.insertAdjacentHTML('afterend', searchHtml);
        const doSearch = () => {
            const q = document.getElementById('rph_reddit_search_input')?.value.trim();
            if (q) _navigateTo('reddit', 'search', { query: q, source: sourcePageId });
        };
        const doGo = () => {
            const q = document.getElementById('rph_reddit_search_input')?.value.trim();
            if (q) _navigateTo('reddit', 'sub', { sub: q.startsWith('r/') ? q : 'r/' + q.replace(/\s+/g, '') });
        };
        document.getElementById('rph_reddit_search_btn')?.addEventListener('click', doSearch);
        document.getElementById('rph_reddit_go_btn')?.addEventListener('click', doGo);
        document.getElementById('rph_reddit_search_input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    };

    if (pageId === 'home' || !pageId) {
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Opened Reddit For You');
        const cacheKey = 'reddit_subs_foryou';
        const renderList = (subs) => {
            _renderRedditSubList(screen, subs, renderTabs('foryou'), {
                title: 'For You',
                allowLoadMore: true,
                onLoadMore: async () => {
                    try {
                        const sceneCtx = _buildSceneContext(1000);
                        const sys = `You generate a list of reddit-like communities fitting this story world. The internet is vast — create GENERAL interest communities, NOT things specifically about the player character or their friends. Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
                        const history = subs.map(s => s.name).join(', ');
                        const usr = `${sceneCtx}\n\nGenerate 6 NEW relevant subreddits for this world. Exclude these: ${history}. Format: [{"name":"r/name","icon":"emoji","description":"short desc"}]`;
                        const raw  = await sendPhoneRequest(sys, usr);
                        const moreSubs = _parseJsonRobust(raw, []);
                        if (moreSubs && moreSubs.length) {
                            ps.phoneCache[cacheKey] = subs.concat(moreSubs);
                            savePhoneState();
                            _renderRedditApp('home', params, screen);
                        }
                    } catch (e) { console.warn('[SillyPhone] Load more failed', e); }
                }
            });
            bindTabs();
            _injectSearchBar(screen.querySelector('.rpg-phone-reddit-header'), pageId);
        };

        if (ps.phoneCache[cacheKey]) {
            renderList(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('home', params, screen); });
            return;
        }

        const sceneCtx = _buildSceneContext(1000);
        const sys = `You generate a list of reddit-like communities fitting this story world. The internet is vast — create GENERAL interest communities, NOT things specifically about the player character or their friends. Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const usr = `${sceneCtx}\n\nGenerate 6 relevant subreddits for this world. Format: [{"name":"r/name","icon":"emoji","description":"short desc"}]`;
        try {
            const raw  = await sendPhoneRequest(sys, usr);
            const subs = _parseJsonRobust(raw, []);
            ps.phoneCache[cacheKey] = subs; savePhoneState();
            renderList(subs);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('home', params, screen); });
        } catch (e) { screen.innerHTML = `${renderTabs('foryou')}<div class="rpg-phone-error">Reddit unavailable: ${_escHtml(e.message)}</div>`; bindTabs(); }
        return;
    }

    if (pageId === 'feed') {
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Opened Reddit Feed');
        const cacheKey = 'reddit_posts_feed';
        const renderList = (posts) => {
            _renderRedditFeed(screen, 'Your Feed', posts, () => _renderRedditApp('feed', { ...params, loadMore: true }, screen));
            const header = screen.querySelector('.rpg-phone-reddit-sub-header');
            if (header) {
                header.insertAdjacentHTML('afterbegin', renderTabs('feed'));
            }
            bindTabs();
        };

        if (ps.phoneCache[cacheKey] && !params.loadMore) {
            renderList(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('feed', params, screen); });
            return;
        }

        const sceneCtx = _buildSceneContext(1000);
        
        // Build context of what the user is subscribed to
        const joined = (ps.phoneRedditJoinedSubs || []).map(s => `${s.name}: ${s.description}`).join(' | ');
        const following = (ps.phoneRedditFollowing || []).map(u => {
            const prof = ps.phoneCache[`reddit_user_${u}`];
            return `${u} (Bio: ${prof?.bio||''}, Visual: ${prof?.visualProfile||''})`;
        }).join(' | ');
        
        const s = getSettings();
        const postCount = s.redditFeedPostCount || '8-12';
        const sys = `You generate a highly personalized Reddit timeline for a user. You must generate ${postCount} posts total.
The posts should be a mix of:
1. Posts from subreddits they joined (specify the subreddit in 'sub').
2. Posts from users they follow (specify the user in 'author', and their sub).
3. "You might like" or "Discover" posts from NEW subreddits they HAVEN'T joined yet, based on their interests.

Joined Subs: ${joined || 'None'}
Followed Users: ${following || 'None'}

Output a JSON array of posts. Format: [{"sub":"r/name", "author":"u/name", "title":"...", "preview":"...", "upvotes": 123, "comments": 12, "imagePrompt":"optional detailed visual description"}]
CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const usr = `${sceneCtx}\n\nGenerate the personalized feed timeline JSON.`;
        
        screen.innerHTML = `${renderTabs('feed')}<div style="padding:20px;text-align:center;">Loading Feed...</div>`;
        bindTabs();
        
        try {
            const raw  = await sendPhoneRequest(sys, usr);
            const posts = _parseJsonRobust(raw, []);
            if (params.loadMore && ps.phoneCache[cacheKey]) {
                ps.phoneCache[cacheKey] = [...ps.phoneCache[cacheKey], ...posts];
            } else {
                ps.phoneCache[cacheKey] = posts;
            }
            savePhoneState();
            renderList(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('feed', { ...params, loadMore: false }, screen); });
        } catch (e) { 
            screen.innerHTML = `${renderTabs('feed')}<div class="rpg-phone-error">Feed unavailable: ${_escHtml(e.message)}</div>`; 
            bindTabs(); 
        }
        return;
    }

    if (pageId === 'discover') {
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Opened Reddit Discover');
        const cacheKey = 'reddit_subs_discover';
        const renderList = (subs) => {
            _renderRedditSubList(screen, subs, renderTabs('discover'), {
                title: 'Discover',
                allowLoadMore: true,
                onLoadMore: async () => {
                    try {
                        const sys = `You generate a list of highly popular, generic internet communities (like r/aww, r/gaming, r/food, r/memes, etc.). Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
                        const history = subs.map(s => s.name).join(', ');
                        const usr = `Generate 6 NEW highly popular generic subreddits. Exclude these: ${history}. Format: [{"name":"r/name","icon":"emoji","description":"short desc"}]`;
                        const raw  = await sendPhoneRequest(sys, usr);
                        const moreSubs = _parseJsonRobust(raw, []);
                        if (moreSubs && moreSubs.length) {
                            ps.phoneCache[cacheKey] = subs.concat(moreSubs);
                            savePhoneState();
                            _renderRedditApp('discover', params, screen);
                        }
                    } catch (e) { console.warn('[SillyPhone] Load more failed', e); }
                }
            });
            bindTabs();
            _injectSearchBar(screen.querySelector('.rpg-phone-reddit-header'), pageId);
        };

        if (ps.phoneCache[cacheKey]) {
            renderList(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('discover', params, screen); });
            return;
        }

        const sys = `You generate a list of highly popular, generic internet communities (like r/aww, r/gaming, r/food, r/memes, etc.). Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const usr = `Generate 6 highly popular generic subreddits. Format: [{"name":"r/name","icon":"emoji","description":"short desc"}]`;
        try {
            screen.innerHTML = `${renderTabs('discover')}<div style="padding:20px;text-align:center;">Discovering popular communities...</div>`;
            const raw  = await sendPhoneRequest(sys, usr);
            const subs = _parseJsonRobust(raw, []);
            ps.phoneCache[cacheKey] = subs; savePhoneState();
            renderList(subs);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('discover', params, screen); });
        } catch (e) { screen.innerHTML = `${renderTabs('discover')}<div class="rpg-phone-error">Reddit unavailable: ${_escHtml(e.message)}</div>`; bindTabs(); }
        return;
    }

    if (pageId === 'search') {
        const query = params.query;
        const source = params.source || 'home';
        const isDiscover = (source === 'discover');
        
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Searched Reddit for: ' + query);
        const cacheKey = `reddit_subs_search_${query}_${source}`;
        
        const getPrompts = (history = '') => {
            const sceneCtx = isDiscover ? '' : _buildSceneContext(1000) + '\n\n';
            const ctxGuidance = isDiscover ? '' : ' that fit logically within this story universe';
            const sys = `You generate a list of reddit communities that match a search query${isDiscover ? '' : ' within the context of a fictional universe'}. Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
            const excl = history ? ` Exclude these: ${history}.` : '';
            const usr = `${sceneCtx}Search Query: "${query}"\nGenerate 6${history ? ' NEW' : ''} subreddits matching this query${ctxGuidance}.${excl} Format: [{"name":"r/name","icon":"emoji","description":"short desc"}]`;
            return { sys, usr };
        };

        const renderList = (subs) => {
            _renderRedditSubList(screen, subs, renderTabs(''), {
                title: `Search: ${query}`,
                allowLoadMore: true,
                onLoadMore: async () => {
                    try {
                        const history = subs.map(s => s.name).join(', ');
                        const { sys, usr } = getPrompts(history);
                        const raw  = await sendPhoneRequest(sys, usr);
                        const moreSubs = _parseJsonRobust(raw, []);
                        if (moreSubs && moreSubs.length) {
                            ps.phoneCache[cacheKey] = subs.concat(moreSubs);
                            savePhoneState();
                            _renderRedditApp('search', params, screen);
                        }
                    } catch (e) { console.warn('[SillyPhone] Load more failed', e); }
                }
            });
            bindTabs();
            _injectSearchBar(screen.querySelector('.rpg-phone-reddit-header'), params.source);
        };

        if (ps.phoneCache[cacheKey]) {
            renderList(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('search', params, screen); });
            return;
        }

        const { sys, usr } = getPrompts();
        try {
            screen.innerHTML = `${renderTabs('')}<div style="padding:20px;text-align:center;">Searching...</div>`;
            const raw  = await sendPhoneRequest(sys, usr);
            const subs = _parseJsonRobust(raw, []);
            ps.phoneCache[cacheKey] = subs; savePhoneState();
            renderList(subs);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('search', params, screen); });
        } catch (e) { screen.innerHTML = `${renderTabs('')}<div class="rpg-phone-error">Search failed: ${_escHtml(e.message)}</div>`; bindTabs(); }
        return;
    }

    if (pageId === 'saved') {
        _setNavTitle('Saved Posts');
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Opened Reddit Saved Posts');
        const saved = ps.phoneRedditSavedPosts || [];
        const items = saved.length === 0 ? '<p class="rpg-phone-muted" style="padding:12px;text-align:center;">No saved posts yet.</p>' : '';
        screen.innerHTML = `${renderTabs('saved')}<div>${items}</div>`;
        bindTabs();
        if (saved.length > 0) {
            const postsHTML = saved.map((p, i) => `
<div class="rpg-phone-reddit-post" data-saved-idx="${i}" style="border:1px solid rgba(255,255,255,0.1);margin:8px 16px;border-radius:8px;cursor:pointer;">
  <div class="rpg-phone-reddit-post-meta">${_escHtml(p.sub || 'r/all')}</div>
  <div class="rpg-phone-reddit-post-title">${_escHtml(p.title || '')}</div>
  <div class="rpg-phone-reddit-post-meta">⬆ ${p.upvotes || 0} · 💬 ${p.comments || 0}</div>
</div>`).join('');
            screen.insertAdjacentHTML('beforeend', postsHTML);
            screen.querySelectorAll('.rpg-phone-reddit-post').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.savedIdx, 10);
                    const p = saved[idx];
                    _navigateTo('reddit', 'post', { sub: p.sub || 'r/all', post: p });
                });
            });
        }
        return;
    }

    if (pageId === 'joined_subs') {
        _setNavTitle('Joined');
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Opened Reddit Joined Subs');
        const joined = ps.phoneRedditJoinedSubs || [];
        const items = joined.map((s, i) => `
<div class="rpg-phone-reddit-sub" data-idx="${i}" style="justify-content: space-between;">
  <div style="display: flex; align-items: center; gap: 12px;">
    <div class="rpg-phone-reddit-sub-icon" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px;">${_renderIcon(s.icon || '🤖')}</div>
    <div>
      <div class="rpg-phone-reddit-sub-name">${_escHtml(s.name)}</div>
      <div class="rpg-phone-reddit-sub-desc">${_escHtml(s.description || '')}</div>
    </div>
  </div>
  <button class="rpg-phone-reddit-btn rpg-phone-reddit-sub-quickjoin" data-idx="${i}" style="padding: 4px 12px; font-size: 12px;">Joined</button>
</div>`).join('');
        screen.innerHTML = `
${renderTabs('joined')}
<div style="padding:12px;text-align:center;">
  <button class="rpg-phone-reddit-btn primary" id="rph_create_custom_sub">+ Create Custom Sub</button>
</div>
${items || '<p class="rpg-phone-muted" style="text-align:center;padding:20px;">You haven\'t joined any communities.</p>'}
`;
        bindTabs();
        document.getElementById('rph_create_custom_sub')?.addEventListener('click', () => _navigateTo('reddit', 'create_sub'));
        
        screen.querySelectorAll('.rpg-phone-reddit-sub-quickjoin').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                const sub = joined[idx];
                const existingIdx = ps.phoneRedditJoinedSubs.findIndex(s => s.name === sub.name);
                if (existingIdx >= 0) {
                    ps.phoneRedditJoinedSubs.splice(existingIdx, 1);
                    btn.textContent = 'Join';
                    btn.classList.add('primary');
                } else {
                    ps.phoneRedditJoinedSubs.push(sub);
                    btn.textContent = 'Joined';
                    btn.classList.remove('primary');
                }
                savePhoneState();
            });
        });

        screen.querySelectorAll('.rpg-phone-reddit-sub').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx, 10);
                _navigateTo('reddit', 'sub', { sub: joined[idx].name, subData: joined[idx] });
            });
        });
        return;
    }

    if (pageId === 'create_sub') {
        _setNavTitle('Create Subreddit');
        screen.innerHTML = `
<div style="padding:16px;">
  <h3>Create Custom Subreddit</h3>
  <input type="text" class="rpg-phone-input-small" id="rph_sub_name" placeholder="Name (e.g. r/localnews)..." style="margin-bottom:12px;" autocomplete="off"/>
  <input type="text" class="rpg-phone-input-small" id="rph_sub_icon" placeholder="Icon (emoji)..." style="margin-bottom:12px;" autocomplete="off"/>
  <textarea class="rpg-phone-textarea" id="rph_sub_desc" placeholder="Describe what this community is about..."></textarea>
  <button class="rpg-phone-reddit-btn primary" id="rph_save_sub" style="margin-top:12px;width:100%;">Create Community</button>
</div>
`;
        document.getElementById('rph_save_sub')?.addEventListener('click', () => {
            let name = document.getElementById('rph_sub_name')?.value.trim() || '';
            const icon = document.getElementById('rph_sub_icon')?.value.trim() || '🤖';
            const desc = document.getElementById('rph_sub_desc')?.value.trim() || '';
            if (!name) return;
            if (!name.startsWith('r/')) name = 'r/' + name;
            name = name.replace(/\s+/g, '');
            ps.phoneRedditJoinedSubs.push({ name, icon, description: desc });
            savePhoneState();
            _navigateTo('reddit', 'sub', { sub: name });
        });
        return;
    }

    if (pageId === 'following') {
        _setNavTitle('Following');
        const users = ps.phoneRedditFollowing || [];
        const items = users.map(u => `
<div class="rpg-phone-reddit-sub" data-user="${_escHtml(u)}">
  <div class="rpg-phone-reddit-profile-avatar" style="width:40px;height:40px;font-size:18px;margin:0;">${u.replace('u/','')[0]?.toUpperCase()}</div>
  <div class="rpg-phone-reddit-sub-name">${_escHtml(u)}</div>
</div>`).join('');
        screen.innerHTML = `${renderTabs('following')}${items || '<p class="rpg-phone-muted" style="text-align:center;padding:20px;">You aren\'t following anyone.</p>'}`;
        bindTabs();
        screen.querySelectorAll('.rpg-phone-reddit-sub').forEach(el => {
            el.addEventListener('click', () => _navigateTo('reddit', 'profile', { user: el.dataset.user }));
        });
        return;
    }

    if (pageId === 'sub') {
        const sub = params.sub || 'r/all';
        _setNavTitle(sub);
        _logPhoneActivity('reddit', sub, 'out', `Browsing ${sub}`);

        const renderSub = (posts) => {
            _renderRedditFeed(screen, sub, posts);
            const joined = ps.phoneRedditJoinedSubs.find(s => s.name === sub);
            const header = screen.querySelector('.rpg-phone-reddit-sub-header');
            if (header) {
                header.style.display = 'flex';
                header.style.justifyContent = 'space-between';
                header.style.alignItems = 'center';
                const btn = document.createElement('button');
                btn.className = `rpg-phone-reddit-btn ${joined ? '' : 'primary'}`;
                btn.textContent = joined ? 'Joined' : 'Join';
                btn.onclick = () => {
                    if (joined) ps.phoneRedditJoinedSubs = ps.phoneRedditJoinedSubs.filter(s => s.name !== sub);
                    else {
                        const icon = params.subData ? params.subData.icon : '🤖';
                        const desc = params.subData ? params.subData.description : '';
                        ps.phoneRedditJoinedSubs.push({ name: sub, icon: icon, description: desc });
                    }
                    savePhoneState();
                    _renderRedditApp('sub', params, screen);
                };
                header.appendChild(btn);
            }
        };

        const cacheKey = `reddit_feed_${sub}`;
        if (ps.phoneCache[cacheKey] && !params.loadMore) {
            renderSub(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('sub', params, screen); });
            return;
        }

        const customSub = ps.phoneRedditJoinedSubs.find(s => s.name === sub);
        const subCtx = customSub && customSub.description ? `This community is about: ${customSub.description}` : '';

        const s = getSettings();
        const postCount = s.redditFeedPostCount || '8-12';
        const sceneCtx = _buildSceneContext(1000);
        const sys = `You generate realistic Reddit posts for the community ${sub} in this story world. Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const usr = `${sceneCtx}\n\n${subCtx}
CRITICAL INSTRUCTION:
Determine if the subreddit '${sub}' is directly related to the specific events or topics in the chat context above.
- If YES: You may include posts related to those topics.
- If NO (e.g. it's a generic sub like r/news, r/gaming, r/aww): The posts MUST be completely unrelated to the chat context. They should be random, worldly posts by strangers on the internet.

Generate ${postCount} Reddit posts for ${sub}. Format: [{"title":"","flair":"","author":"u/name","upvotes":0,"comments":0,"preview":"short preview text","imagePrompt":"<${s.imagePromptInstruction || 'visual description if applicable, else empty'}>"}]`;
        try {
            const raw   = await sendPhoneRequest(sys, usr);
            const posts = _parseJsonRobust(raw, []);
            if (params.loadMore && ps.phoneCache[cacheKey]) {
                ps.phoneCache[cacheKey] = [...ps.phoneCache[cacheKey], ...posts];
            } else {
                ps.phoneCache[cacheKey] = posts;
            }
            savePhoneState();
            renderSub(ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('sub', { ...params, loadMore: false }, screen); });
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Feed failed: ${_escHtml(e.message)}</div>`; }
        return;
    }

    if (pageId === 'post') {
        const post = params.post || {};
        _setNavTitle(post.title ? post.title.slice(0, 30) + '…' : 'Post');
        _logPhoneActivity('reddit', params.sub || 'Reddit', 'in', `Read post: "${_summarizeText(post.title, 60)}"`);

        const cacheKey = `reddit_post_${params.sub}_${encodeURIComponent(post.title || '')}`;
        if (ps.phoneCache[cacheKey]) {
            _renderRedditPost(screen, post, params.sub, ps.phoneCache[cacheKey]);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('post', params, screen); });
            return;
        }

        const s = getSettings();
        const sceneCtx = _buildSceneContext(1000);
        const sys = `You write the body text and comments for a Reddit post in this story world. Reply ONLY valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        

        const authorProfile = post.author ? ps?.phoneCache?.[`reddit_user_${post.author}`] : null;
        const authorVisual = authorProfile?.visualProfile ? `\nAuthor Visual Profile (incorporate this into image prompts if the author is pictured): ${authorProfile.visualProfile}` : '';

        const usr = `${sceneCtx}\n\nCRITICAL INSTRUCTION:
Determine if the subreddit '${params.sub}' and the post title "${post.title}" are directly related to the specific events or topics in the chat context above.
- If YES: The post body and comments can relate to the chat context.
- If NO: The post body and comments MUST be completely unrelated to the characters or their immediate situation. Keep it realistic to a general internet forum written by strangers.

VARY POST LENGTH: Depending on the subreddit and post type (e.g. story, confession, meme, news), the body text length should vary naturally. Some posts are long essays, some are just a short sentence, and some are entirely empty beyond the title/preview. Do not force every post to be a multi-paragraph essay.

Write the body and top comments for this Reddit post in ${params.sub}:
Title: "${post.title}"
Flair: ${post.flair || ''}
Preview: ${post.preview || ''}${authorVisual}

Reply ONLY with: {"body":"full post body text","comments":[{"author":"u/name","upvotes":0,"text":"comment text","replies":[{"author":"u/name","upvotes":0,"text":"reply"}]}]} CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        try {
            const raw   = await sendPhoneRequest(sys, usr);
            const data = _parseJsonRobust(raw, { body: '', comments: [] });
            ps.phoneCache[cacheKey] = data; savePhoneState();
            _renderRedditPost(screen, post, params.sub, data);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('post', params, screen); });
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Post failed: ${_escHtml(e.message)}</div>`; }
        return;
    }

    if (pageId === 'profile') {
        const user = params.user;
        const s = getSettings();
        _setNavTitle(user);
        _logPhoneActivity('reddit', user, 'in', 'Viewed profile of user: ' + user);
        const cacheKey = `reddit_user_${user}`;
        
        const renderProfile = (data) => {
            const isFollowing = ps.phoneRedditFollowing.includes(user);
            const postsHtml = (data.recentPosts || []).map((p, i) => `
<div class="rpg-phone-reddit-post" data-idx="${i}" style="border:1px solid rgba(255,255,255,0.1);margin:8px 16px;border-radius:8px;cursor:pointer;">
  <div class="rpg-phone-reddit-post-meta">${_escHtml(p.sub || 'r/all')}</div>
  <div class="rpg-phone-reddit-post-title">${_escHtml(p.title || '')}</div>
  <div class="rpg-phone-reddit-post-meta">⬆ ${p.upvotes || 0} · 💬 ${p.comments || 0}</div>
</div>`).join('');

            screen.innerHTML = `
<div class="rpg-phone-reddit-profile-header">
  <div class="rpg-phone-reddit-profile-avatar">${user.replace('u/','')[0]?.toUpperCase() || 'U'}</div>
  <div class="rpg-phone-reddit-profile-name">${_escHtml(user)}</div>
  <div class="rpg-phone-reddit-profile-bio">${_escHtml(data.bio || '')}</div>
  ${data.visualProfile ? `<div style="font-style:italic; font-size:11px; color:#aaa; margin-top:8px; line-height:1.2;">[OOC Visual: ${_escHtml(data.visualProfile)}]</div>` : ''}
  <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
    <button class="rpg-phone-reddit-btn ${isFollowing ? '' : 'primary'}" id="rph_follow_user">${isFollowing ? 'Following' : 'Follow'}</button>
    <button class="rpg-phone-reddit-btn" id="rph_dm_user">Message</button>
    <button class="rpg-phone-reddit-btn" id="rph_refresh_profile" title="Refresh Activity">↻</button>
  </div>
</div>
<div>${postsHtml}</div>`;
            document.getElementById('rph_follow_user')?.addEventListener('click', () => {
                if (isFollowing) {
                    ps.phoneRedditFollowing = ps.phoneRedditFollowing.filter(u => u !== user);
                    _logPhoneActivity('reddit', user, 'out', 'Unfollowed user: ' + user);
                } else {
                    ps.phoneRedditFollowing.push(user);
                    _logPhoneActivity('reddit', user, 'out', 'Followed user: ' + user);
                }
                savePhoneState();
                _renderRedditApp('profile', params, screen);
            });
            document.getElementById('rph_dm_user')?.addEventListener('click', () => {
                _navigateTo('reddit', 'dm_thread', { user });
            });
            document.getElementById('rph_refresh_profile')?.addEventListener('click', async () => {
                const btn = document.getElementById('rph_refresh_profile');
                btn.disabled = true;
                btn.textContent = '...';
                const sys = `You generate a Reddit user profile. Reply ONLY valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
                const usr = `Generate 5 NEW recent posts for reddit user ${user}. Maintain this established vibe/bio:\n"${data.bio}"\nFormat: {"bio":"${data.bio}","visualProfile":${JSON.stringify(data.visualProfile || '')},"recentPosts":[{"title":"","sub":"r/name","upvotes":0,"comments":0,"imagePrompt":"<${s.imagePromptInstruction || 'visual description if applicable, else empty'}>"}]}`;
                try {
                    const raw = await sendPhoneRequest(sys, usr);
                    const newData = _parseJsonRobust(raw, null);
                    if (newData) {
                        data.recentPosts = newData.recentPosts;
                        ps.phoneCache[cacheKey] = data;
                        savePhoneState();
                        _renderRedditApp('profile', params, screen);
                    }
                } catch(e) { console.warn('Profile refresh failed', e); btn.disabled = false; btn.textContent = '↻'; }
            });
            screen.querySelectorAll('.rpg-phone-reddit-post').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.idx, 10);
                    const p = data.recentPosts[idx];
                    if (p) {
                        p.author = user; // Ensure author is set when viewing from profile
                        _navigateTo('reddit', 'post', { sub: p.sub || 'r/all', post: p });
                    }
                });
            });
        };

        if (ps.phoneCache[cacheKey]) { renderProfile(ps.phoneCache[cacheKey]); return; }

        const sys = `You generate a Reddit user profile. Reply ONLY valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const profileCtx = params.context ? `This user was found via this context:\n${params.context}\nMake sure their bio and recent posts align with this personality.` : '';
        const visualInst = s.profileVisualPrompt ? `\nGenerate a detailed "visualProfile" string for them adhering to: ${s.profileVisualPrompt}` : '';
        const usr = `Generate a realistic profile for reddit user ${user}. ${profileCtx}${visualInst}\nFormat: {"bio":"short bio","visualProfile":"detailed appearance","recentPosts":[{"title":"","sub":"r/name","upvotes":0,"comments":0,"imagePrompt":"<${s.imagePromptInstruction || 'visual description if applicable, else empty'}>"}]}`;
        try {
            screen.innerHTML = `<div class="rpg-phone-loading"><div class="rpg-phone-spinner"></div><p>Loading Profile…</p></div>`;
            const raw = await sendPhoneRequest(sys, usr);
            const data = _parseJsonRobust(raw, { bio: '', recentPosts: [] });
            if (params.sourcePost && params.sourcePost.author === user) {
                data.recentPosts = data.recentPosts.filter(p => p.title !== params.sourcePost.title);
                data.recentPosts.unshift(params.sourcePost);
            }
            ps.phoneCache[cacheKey] = data; savePhoneState();
            renderProfile(data);
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Profile failed: ${_escHtml(e.message)}</div>`; }
        return;
    }

    if (pageId === 'dm_list') {
        _setNavTitle('Chats');
        _logPhoneActivity('reddit', 'Chats', 'out', 'Opened Reddit DMs');
        const dms = Object.entries(ps.phoneRedditDMs || {}).filter(([, msgs]) => msgs.length > 0);
        const rows = dms.map(([user, msgs]) => `
<div class="rpg-phone-reddit-dm-row" data-user="${_escHtml(user)}">
  <div class="rpg-phone-reddit-dm-avatar">${user.replace('u/','')[0]?.toUpperCase() || 'U'}</div>
  <div style="flex:1">
    <div style="font-weight:700;">${_escHtml(user)}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.6);">${_escHtml(_summarizeText(msgs[msgs.length - 1].text, 40))}</div>
  </div>
</div>`).join('');
        screen.innerHTML = `${renderTabs('dms')}<div class="rpg-phone-reddit-dm-list">${rows || '<p class="rpg-phone-muted" style="text-align:center;padding:20px;">No active chats.</p>'}</div>`;
        bindTabs();
        screen.querySelectorAll('.rpg-phone-reddit-dm-row').forEach(el => {
            el.addEventListener('click', () => _navigateTo('reddit', 'dm_thread', { user: el.dataset.user }));
        });
        return;
    }

    if (pageId === 'dm_thread') {
        const user = params.user;
        _setNavTitle(user);
        _logPhoneActivity('reddit', user, 'out', 'Opened Reddit DM thread with ' + user);
        const msgs = ps.phoneRedditDMs[user] || [];
        const bubblesHTML = msgs.map(m => `
<div class="rpg-phone-sms-bubble ${m.direction === 'out' ? 'rpg-phone-sms-out' : 'rpg-phone-sms-in'}">
  ${_escHtml(m.text || '')}
</div>`).join('');

        screen.innerHTML = `
<div class="rpg-phone-sms-thread">
  <div class="rpg-phone-sms-bubbles" id="rph_dm_bubbles">
    ${bubblesHTML || `<p class="rpg-phone-muted" style="text-align:center;padding:20px;">Chat with ${user}</p>`}
  </div>
  <div class="rpg-phone-sms-compose">
    <input type="text" class="rpg-phone-sms-input" id="rph_dm_input" placeholder="Message…" autocomplete="off"/>
    <button class="rpg-phone-sms-send-btn" id="rph_dm_send">▶</button>
  </div>
</div>`;
        const bubbles = document.getElementById('rph_dm_bubbles');
        if (bubbles) bubbles.scrollTop = bubbles.scrollHeight;

        const sendMsg = async () => {
            const input = document.getElementById('rph_dm_input');
            const text = input?.value.trim();
            if (!text) return;
            input.value = '';
            
            const outBubble = document.createElement('div');
            outBubble.className = 'rpg-phone-sms-bubble rpg-phone-sms-out';
            outBubble.textContent = text;
            bubbles.appendChild(outBubble);
            bubbles.scrollTop = bubbles.scrollHeight;

            if (!ps.phoneRedditDMs[user]) ps.phoneRedditDMs[user] = [];
            ps.phoneRedditDMs[user].push({ text, direction: 'out' });
            savePhoneState();
            _logPhoneActivity('reddit', user, 'out', text);

            try {
                const { pcName } = _getPlayerCharacterInfo();
                const myName = `u/${(pcName || 'Player').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
                const history = ps.phoneRedditDMs[user].map(m => `${m.direction === 'out' ? myName : user}: ${m.text}`).join('\n');
                const sceneCtx = _buildSceneContext(1000);
                
                const profile = ps.phoneCache[`reddit_user_${user}`];
                let profileCtx = '';
                if (profile) {
                    profileCtx = `\n\nYour Profile Info:\nBio: ${profile.bio || 'None'}\nVisual/Vibe: ${profile.visualProfile || 'None'}`;
                    if (profile.recentPosts && profile.recentPosts.length) {
                        const postsList = profile.recentPosts.slice(0, 5).map(p => `- [${p.sub || 'unknown'}] ${p.title || 'untitled'}`).join('\n');
                        profileCtx += `\nYour Recent Posts:\n${postsList}`;
                    }
                }

                const sys = `You are roleplaying as Reddit user ${user} in a private DM chat. You are a stranger on the internet. Keep it realistic to Reddit chat culture.${profileCtx}\n\nReply ONLY with your message text.`;
                const usr = `${sceneCtx}\n\nChat History:\n${history}\n\n${user} replies:`;
                const reply = (await sendPhoneRequest(sys, usr)).trim();

                ps.phoneRedditDMs[user].push({ text: reply, direction: 'in' });
                savePhoneState();
                _logPhoneActivity('reddit', user, 'in', reply);
                
                const inBubble = document.createElement('div');
                inBubble.className = 'rpg-phone-sms-bubble rpg-phone-sms-in';
                inBubble.textContent = reply;
                bubbles.appendChild(inBubble);
                bubbles.scrollTop = bubbles.scrollHeight;
            } catch (e) {}
        };
        document.getElementById('rph_dm_send')?.addEventListener('click', sendMsg);
        document.getElementById('rph_dm_input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
        return;
    }
}

function _bindRedditUserLinks(screen) {
    screen.querySelectorAll('.rpg-phone-reddit-user-link').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            let context = '';
            let originalPost = null;
            const postEl = el.closest('.rpg-phone-reddit-post, .rpg-phone-reddit-post-detail');
            if (postEl) {
                if (postEl.dataset.postJson) {
                    try { originalPost = JSON.parse(postEl.dataset.postJson); } catch (e) {}
                }
                if (originalPost) {
                    if (originalPost.sub) context += `Subreddit: "${originalPost.sub}"\n`;
                    context += `Post Title: "${originalPost.title || ''}"\n`;
                    if (originalPost.flair) context += `Post Flair: "${originalPost.flair}"\n`;
                    if (originalPost.preview) context += `Post Preview: "${originalPost.preview}"\n`;
                    if (originalPost.body) context += `Post Body: "${originalPost.body}"\n`;
                    if (originalPost.imagePrompt) context += `Post Image: "${originalPost.imagePrompt}"\n`;
                } else {
                    const title = postEl.querySelector('.rpg-phone-reddit-post-title, .rpg-phone-reddit-post-detail-title')?.textContent;
                    if (title) context += `Post Title: "${title}"\n`;
                }
            }
            const commentEl = el.closest('.rpg-phone-reddit-comment');
            if (commentEl) {
                const text = commentEl.querySelector('.rpg-phone-reddit-comment-text')?.textContent;
                if (text) context += `Commented: "${text}"\n`;
            }
            _navigateTo('reddit', 'profile', { user: el.textContent.trim(), context: context.trim(), sourcePost: originalPost });
        });
    });
}

function _renderRedditSubList(screen, subs, tabsHtml = '', config = {}) {
    const title = config.title || 'Discover';
    const ps = getPhoneState();
    const html = subs.map((s, i) => {
        const isJoined = ps.phoneRedditJoinedSubs.some(js => js.name === s.name);
        return `
<div class="rpg-phone-reddit-sub" data-idx="${i}" style="justify-content: space-between;">
  <div style="display: flex; align-items: center; gap: 12px;">
    <div class="rpg-phone-reddit-sub-icon" style="display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px;">${_renderIcon(s.icon || '🤖')}</div>
    <div>
      <div class="rpg-phone-reddit-sub-name">${_escHtml(s.name)}</div>
      <div class="rpg-phone-reddit-sub-desc">${_escHtml(s.description || '')}</div>
    </div>
  </div>
  <button class="rpg-phone-reddit-btn rpg-phone-reddit-sub-quickjoin ${isJoined ? '' : 'primary'}" data-idx="${i}" style="padding: 4px 12px; font-size: 12px;">
    ${isJoined ? 'Joined' : 'Join'}
  </button>
</div>`;
    }).join('');

    let extraHtml = '';
    if (config.allowLoadMore) {
        extraHtml = `<div style="text-align:center; padding:12px;"><button class="rpg-phone-reddit-btn" id="rph_sublist_loadmore" style="width:100%;justify-content:center;">↻ Load More</button></div>`;
    }

    screen.innerHTML = `${tabsHtml}<div class="rpg-phone-reddit-header"><span class="rpg-phone-reddit-logo">reddit</span><span>${_escHtml(title)}</span></div>${html}${extraHtml}`;
    
    screen.querySelectorAll('.rpg-phone-reddit-sub-quickjoin').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const sub = subs[idx];
            const existingIdx = ps.phoneRedditJoinedSubs.findIndex(s => s.name === sub.name);
            if (existingIdx >= 0) {
                ps.phoneRedditJoinedSubs.splice(existingIdx, 1);
                btn.textContent = 'Join';
                btn.classList.add('primary');
                _logPhoneActivity('reddit', sub.name, 'out', 'Left subreddit: ' + sub.name);
            } else {
                ps.phoneRedditJoinedSubs.push(sub);
                btn.textContent = 'Joined';
                btn.classList.remove('primary');
                _logPhoneActivity('reddit', sub.name, 'out', 'Joined subreddit: ' + sub.name);
            }
            savePhoneState();
        });
    });

    screen.querySelectorAll('.rpg-phone-reddit-sub').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            _navigateTo('reddit', 'sub', { sub: subs[idx].name, subData: subs[idx] });
        });
    });

    if (config.allowLoadMore && config.onLoadMore) {
        document.getElementById('rph_sublist_loadmore')?.addEventListener('click', async (e) => {
            e.target.disabled = true;
            e.target.textContent = '...';
            await config.onLoadMore();
        });
    }
}

function _renderRedditFeed(screen, sub, posts, onLoadMore) {
    const ps = getPhoneState();
    const postsHTML = posts.map((p, i) => {
        const actualSub = p.sub || sub;
        const isSaved = ps.phoneRedditSavedPosts.some(sp => sp.title === p.title && sp.sub === actualSub);
        const isJoined = ps.phoneRedditJoinedSubs.some(js => js.name === actualSub);
        
        let subHeaderHtml = '';
        if (actualSub && actualSub !== sub && actualSub.startsWith('r/')) {
            subHeaderHtml = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
              <span style="font-weight:bold; color:#ff6314; cursor:pointer;" class="rpg-phone-reddit-sub-link" data-sub="${_escHtml(actualSub)}">${_escHtml(actualSub)}</span>
              <button class="rpg-phone-reddit-btn rpg-phone-reddit-sub-quickjoin ${isJoined ? '' : 'primary'}" data-sub="${_escHtml(actualSub)}" style="padding: 2px 8px; font-size: 11px;">${isJoined ? 'Joined' : 'Join'}</button>
            </div>`;
        }
        
        return `
<div class="rpg-phone-reddit-post" data-idx="${i}" data-post-json="${_escHtml(JSON.stringify(p))}">
  ${subHeaderHtml}
  ${p.flair ? `<span class="rpg-phone-reddit-flair">${_escHtml(p.flair)}</span>` : ''}
  <div class="rpg-phone-reddit-post-title">${_escHtml(p.title || '')}</div>
  <div class="rpg-phone-reddit-post-meta" style="display:flex; justify-content:space-between; align-items:center;">
    <div>
      <span>⬆ ${p.upvotes || 0}</span>
      <span style="margin-left:8px">💬 ${p.comments || 0}</span>
      <span class="rpg-phone-reddit-user-link" style="margin-left:8px">${_escHtml(p.author || '')}</span>
    </div>
    <span class="rpg-phone-reddit-save-btn" data-idx="${i}" style="cursor:pointer; font-size:16px;">${isSaved ? '🔖' : '🏷️'}</span>
  </div>
  ${p.imagePrompt ? `<div style="margin-top:8px;">${_parsePhoneImages(`[IMAGE: ${p.imagePrompt}]`)}</div>` : ''}
  ${p.preview ? `<div class="rpg-phone-reddit-post-preview">${_escHtml(p.preview)}</div>` : ''}
</div>`;
    }).join('');
    
          let loadMoreHTML = '';
      if (onLoadMore) {
          loadMoreHTML = `<div style="text-align:center; padding: 16px; padding-bottom:32px;"><button id="rph_reddit_feed_load_more" class="rpg-phone-reddit-btn" style="padding:8px 16px;">Load More</button></div>`;
      }
      screen.innerHTML = `<div class="rpg-phone-reddit-sub-header">${_escHtml(sub)}</div>${postsHTML}${loadMoreHTML}`;
      _bindRedditUserLinks(screen);
      
      if (onLoadMore) {
          const loadBtn = document.getElementById('rph_reddit_feed_load_more');
          if (loadBtn) {
              loadBtn.addEventListener('click', (e) => {
                  e.stopPropagation();
                  loadBtn.disabled = true;
                  loadBtn.textContent = 'Loading...';
                  onLoadMore();
              });
          }
      }
    
    screen.querySelectorAll('.rpg-phone-reddit-sub-link').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            _navigateTo('reddit', 'sub', { sub: el.dataset.sub });
        });
    });
    
    screen.querySelectorAll('.rpg-phone-reddit-sub-quickjoin').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const subName = btn.dataset.sub;
            const existingIdx = ps.phoneRedditJoinedSubs.findIndex(s => s.name === subName);
            if (existingIdx >= 0) {
                ps.phoneRedditJoinedSubs.splice(existingIdx, 1);
                btn.textContent = 'Join';
                btn.classList.add('primary');
                _logPhoneActivity('reddit', subName, 'out', 'Left subreddit: ' + subName);
            } else {
                ps.phoneRedditJoinedSubs.push({ name: subName, icon: '🤖', description: '' });
                btn.textContent = 'Joined';
                btn.classList.remove('primary');
                _logPhoneActivity('reddit', subName, 'out', 'Joined subreddit: ' + subName);
            }
            savePhoneState();
        });
    });

    screen.querySelectorAll('.rpg-phone-reddit-save-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const p = posts[idx];
            const actualSub = p.sub || sub;
            const savedIdx = ps.phoneRedditSavedPosts.findIndex(sp => sp.title === p.title && sp.sub === actualSub);
            if (savedIdx >= 0) {
                ps.phoneRedditSavedPosts.splice(savedIdx, 1);
                btn.textContent = '🏷️';
                _logPhoneActivity('reddit', actualSub, 'out', `Unsaved post: "${_summarizeText(p.title, 50)}"`);
            } else {
                ps.phoneRedditSavedPosts.push({ ...p, sub: actualSub });
                btn.textContent = '🔖';
                _logPhoneActivity('reddit', actualSub, 'out', `Saved post: "${_summarizeText(p.title, 50)}"`);
            }
            savePhoneState();
        });
    });
    screen.querySelectorAll('.rpg-phone-reddit-post').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            const actualSub = posts[idx].sub || sub;
            _navigateTo('reddit', 'post', { sub: actualSub, post: posts[idx] });
        });
    });
    
    _bindPhoneImages(screen);
}

function _renderRedditPost(screen, post, sub, data) {
    const ps = getPhoneState();
    const voteKey = `${sub}_${encodeURIComponent(post.title || '')}`;
    const vote = ps.phoneVotes[voteKey] || 0;
    const { pcName } = _getPlayerCharacterInfo();
    const myUsername = `u/${(pcName || 'Player').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    const renderComments = (commentsArr, parentPath = '') => {
        return (commentsArr || []).map((c, i) => {
            const currentPath = parentPath ? `${parentPath},${i}` : `${i}`;
            const repliesHTML = c.replies && c.replies.length ? renderComments(c.replies, currentPath) : '';
            return `
<div class="rpg-phone-reddit-comment">
  <span class="rpg-phone-reddit-user-link rpg-phone-reddit-comment-author">${_escHtml(c.author || '')}</span>
  <span class="rpg-phone-reddit-comment-up">⬆ ${c.upvotes || 0}</span>
  <div class="rpg-phone-reddit-comment-text">${_escHtml(c.text || '')}</div>
  <div class="rpg-phone-reddit-comment-actions">
    <button class="rpg-phone-reddit-reply-btn" data-reply-path="${currentPath}">Reply</button>
  </div>
  <div class="rpg-phone-reddit-input-box" id="rph_reply_box_${currentPath}" style="display:none;">
    <input type="text" class="rpg-phone-input-small" placeholder="Add a reply..." style="flex:1" autocomplete="off"/>
    <button class="rpg-phone-reddit-btn primary" data-send-reply="${currentPath}">Post</button>
  </div>
  ${repliesHTML ? `<div class="rpg-phone-reddit-reply">${repliesHTML}</div>` : ''}
</div>`;
        }).join('');
    };

    const commentsHTML = renderComments(data.comments);

    screen.innerHTML = `
<div class="rpg-phone-reddit-post-detail" data-post-json="${_escHtml(JSON.stringify({ ...post, body: data.body }))}">
  <div class="rpg-phone-reddit-post-meta" style="margin-bottom:8px;"><span class="rpg-phone-reddit-user-link">${_escHtml(post.author || '')}</span></div>
  ${post.flair ? `<span class="rpg-phone-reddit-flair">${_escHtml(post.flair)}</span>` : ''}
  <div class="rpg-phone-reddit-post-detail-title">${_escHtml(post.title || '')}</div>
  ${post.imagePrompt ? `<div style="margin-bottom:12px;">${_parsePhoneImages(`[IMAGE: ${post.imagePrompt}]`)}</div>` : ''}
  <div class="rpg-phone-reddit-post-body">${_escHtml(data.body || '')}</div>
  <div class="rpg-phone-reddit-post-actions" style="display:flex; align-items:center;">
    <button class="rpg-phone-vote-btn ${vote > 0 ? 'voted-up' : ''}" id="rph_vote_up">⬆</button>
    <span class="rpg-phone-vote-score ${vote > 0 ? 'vote-up' : vote < 0 ? 'vote-down' : ''}" id="rph_vote_score">${(post.upvotes || 0) + vote}</span>
    <button class="rpg-phone-vote-btn ${vote < 0 ? 'voted-down' : ''}" id="rph_vote_dn">⬇</button>
    <span style="margin-left:8px">💬 ${post.comments || 0}</span>
    <button class="rpg-phone-reddit-btn" id="rph_save_post" style="margin-left:auto; padding:2px 8px;">${ps.phoneRedditSavedPosts.some(sp => sp.title === post.title) ? 'Saved 🔖' : 'Save 📑'}</button>
  </div>
  <div class="rpg-phone-reddit-comments-section">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h4 style="margin:0;">Comments</h4>
      <button class="rpg-phone-reddit-btn" id="rph_load_more_comments" style="padding:2px 8px;font-size:12px;">↻ Load More</button>
    </div>
    <div class="rpg-phone-reddit-input-box" style="margin-bottom:16px;">
      <input type="text" class="rpg-phone-input-small" id="rph_main_comment_input" placeholder="Add a comment..." style="flex:1" autocomplete="off"/>
      <button class="rpg-phone-reddit-btn primary" id="rph_main_comment_btn">Post</button>
    </div>
    ${commentsHTML || '<p class="rpg-phone-muted" style="padding:8px 0">No comments yet.</p>'}
  </div>
</div>`;

    _bindRedditUserLinks(screen);
    _bindPhoneImages(screen);

    const scoreEl = screen.querySelector('#rph_vote_score');
    const upBtn   = screen.querySelector('#rph_vote_up');
    const dnBtn   = screen.querySelector('#rph_vote_dn');
    const updateVote = (delta) => {
        const old = ps.phoneVotes[voteKey] || 0;
        ps.phoneVotes[voteKey] = old === delta ? 0 : delta;
        const newV = ps.phoneVotes[voteKey];
        if (scoreEl) scoreEl.textContent = String((post.upvotes || 0) + newV);
        upBtn?.classList.toggle('voted-up', newV > 0);
        dnBtn?.classList.toggle('voted-down', newV < 0);
        savePhoneState();
        _logPhoneActivity('reddit', sub, 'out', `${newV > 0 ? 'Upvoted' : newV < 0 ? 'Downvoted' : 'Removed vote on'} post: "${_summarizeText(post.title, 50)}"`);
    };
    upBtn?.addEventListener('click', () => updateVote(1));
    dnBtn?.addEventListener('click', () => updateVote(-1));

    document.getElementById('rph_save_post')?.addEventListener('click', (e) => {
        const btn = e.target;
        post.sub = sub;
        const existingIdx = ps.phoneRedditSavedPosts.findIndex(sp => sp.title === post.title);
        if (existingIdx >= 0) { ps.phoneRedditSavedPosts.splice(existingIdx, 1); btn.textContent = 'Save 📑'; }
        else { ps.phoneRedditSavedPosts.push(post); btn.textContent = 'Saved 🔖'; }
        savePhoneState();
    });

    document.getElementById('rph_load_more_comments')?.addEventListener('click', async () => {
        const btn = document.getElementById('rph_load_more_comments');
        btn.disabled = true;
        btn.textContent = '...';
        const sceneCtx = _buildSceneContext(800);
        const sys = `You write Reddit comments. Reply ONLY valid JSON array. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const historyStr = data.comments.map(c => `${c.author}: ${c.text}`).join('\n');
        const usr = `${sceneCtx}\n\nPost Title: "${post.title}"\nExisting Comments:\n${historyStr}\n\nGenerate 3 NEW top-level comments to append to this thread from strangers on the internet. Format: [{"author":"u/name","upvotes":0,"text":"comment text","replies":[]}]`;
        try {
            const raw = await sendPhoneRequest(sys, usr);
            const newComms = _parseJsonRobust(raw, []);
            if (newComms && newComms.length) {
                data.comments = data.comments.concat(newComms);
                const cacheKey = `reddit_post_${sub}_${encodeURIComponent(post.title || '')}`;
                ps.phoneCache[cacheKey] = data;
                savePhoneState();
                _renderRedditPost(screen, post, sub, data);
            }
        } catch(e) { console.warn('Load more comments failed', e); btn.disabled = false; btn.textContent = '↻ Load More'; }
    });

    // Handle Commenting / Replying
    const addCommentToData = async (text, pathStr) => {
        if (!text) return;
        let targetArr = data.comments;
        if (pathStr) {
            const indices = pathStr.split(',').map(Number);
            let current = { replies: data.comments };
            for (const idx of indices) {
                current = current.replies[idx];
                if (!current.replies) current.replies = [];
            }
            targetArr = current.replies;
        }
        
        targetArr.push({ author: myUsername, upvotes: 1, text, replies: [] });
        
        // Cache update
        const cacheKey = `reddit_post_${sub}_${encodeURIComponent(post.title || '')}`;
        ps.phoneCache[cacheKey] = data;
        savePhoneState();
        _logPhoneActivity('reddit', sub, 'out', 'Commented on post: "' + text + '"');
        _renderRedditPost(screen, post, sub, data);

        // Trigger AI to generate a reply
        try {
            const sceneCtx = _buildSceneContext(800);
            const sys = `You generate a reply to a user's comment on a Reddit post in this story world. The author is a stranger. Reply ONLY valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
            const usr = `${sceneCtx}\n\nPost: "${post.title}"\nUser (${myUsername}) commented: "${text}"\nGenerate 1 realistic Reddit reply to this comment from another user.\nFormat: {"author":"u/name","upvotes":0,"text":"comment text"}`;
            const raw = await sendPhoneRequest(sys, usr);
            const replyData = _parseJsonRobust(raw, null);
            if (replyData) {
                replyData.replies = [];
                // Add the AI reply to the array we just pushed to
                targetArr[targetArr.length - 1].replies.push(replyData);
                ps.phoneCache[cacheKey] = data;
                savePhoneState();
                _renderRedditPost(screen, post, sub, data); // Re-render with AI reply
            }
        } catch (e) { console.warn('Reddit AI reply failed', e); }
    };

    // Bind Top-Level Comment
    document.getElementById('rph_main_comment_btn')?.addEventListener('click', () => {
        const input = document.getElementById('rph_main_comment_input');
        addCommentToData(input?.value.trim(), null);
    });

    // Bind Reply Buttons
    screen.querySelectorAll('[data-reply-path]').forEach(btn => {
        btn.addEventListener('click', () => {
            const box = document.getElementById(`rph_reply_box_${btn.dataset.replyPath}`);
            if (box) box.style.display = box.style.display === 'none' ? 'flex' : 'none';
        });
    });

    // Bind Send Reply Buttons
    screen.querySelectorAll('[data-send-reply]').forEach(btn => {
        btn.addEventListener('click', () => {
            const path = btn.dataset.sendReply;
            const box = document.getElementById(`rph_reply_box_${path}`);
            const input = box?.querySelector('input');
            addCommentToData(input?.value.trim(), path);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// APP STORE
// ─────────────────────────────────────────────────────────────────────────────

async function _renderAppStoreApp(pageId, params, screen) {
    _setNavTitle('App Store');
    const ps = getPhoneState();

    if (pageId === 'home' || !pageId) {
        _logPhoneActivity('app', 'App Store', 'out', 'Browsed App Store');
        const installedHTML = (ps.phoneApps || []).map(a => `
<div class="rpg-phone-appstore-installed" data-appid="${_escHtml(a.id)}" style="cursor:pointer">
  <span class="rpg-phone-appstore-app-icon" style="display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px;">${_renderIcon(a.icon || '📱')}</span>
  <div>
    <div class="rpg-phone-appstore-app-name">${_escHtml(a.name)}</div>
    <div class="rpg-phone-appstore-app-desc">${_escHtml(a.description || '')}</div>
  </div>
</div>`).join('') || '<p class="rpg-phone-muted" style="padding:8px 0">No apps installed yet.</p>';

        screen.innerHTML = `
<div class="rpg-phone-appstore">
  <div class="rpg-phone-appstore-hero">
    <h3>App Store</h3>
    <p class="rpg-phone-muted">Create and install AI-powered apps for this world.</p>
  </div>
  <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_appstore_create">+ Design New App</button>
  <div class="rpg-phone-appstore-installed-section">
    <h4>Installed Apps</h4>
    ${installedHTML}
  </div>
</div>`;
        document.getElementById('rpg_phone_appstore_create')?.addEventListener('click', () => _navigateTo('appstore', 'design'));
        screen.querySelectorAll('.rpg-phone-appstore-installed').forEach(el => {
            el.addEventListener('click', () => _navigateTo(`installed_${el.dataset.appid}`));
        });
        return;
    }

    if (pageId === 'design') {
        _setNavTitle('Design App');
        screen.innerHTML = `
<div class="rpg-phone-appstore-design">
  <h3>Design Your App</h3>
  <div class="rpg-phone-appstore-field">
    <label>App Name</label>
    <input type="text" class="rpg-phone-input-small" id="rpg_app_name_input" placeholder="e.g., CityNews, JobBoard…" autocomplete="off"/>
  </div>
  <div class="rpg-phone-appstore-field">
    <label>App Icon (emoji)</label>
    <input type="text" class="rpg-phone-input-small" id="rpg_app_icon_input" placeholder="📰" maxlength="4" autocomplete="off"/>
  </div>
  <div class="rpg-phone-appstore-field">
    <label>App Purpose / Description</label>
    <textarea class="rpg-phone-textarea" id="rpg_app_desc_input" placeholder="A local news app for the city. Shows headlines, crime reports, and events…"></textarea>
  </div>
  <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_create_app_btn">🚀 Create App</button>
</div>`;

        document.getElementById('rpg_phone_create_app_btn')?.addEventListener('click', async () => {
            const nameEl = document.getElementById('rpg_app_name_input');
            const iconEl = document.getElementById('rpg_app_icon_input');
            const descEl = document.getElementById('rpg_app_desc_input');
            const name = nameEl?.value.trim();
            const icon = iconEl?.value.trim() || '📱';
            const desc = descEl?.value.trim();
            if (!name || !desc) { alert('Please fill in name and description.'); return; }

            nameEl.disabled = descEl.disabled = true;
            screen.innerHTML = `<div class="rpg-phone-loading"><div class="rpg-phone-spinner"></div><p>Creating ${_escHtml(name)}…</p></div>`;

            const sceneCtx = _buildSceneContext(1200);
            const sys = `You design a JSON blueprint for a fictional smartphone app that fits this story world. Reply ONLY valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
            const usr = `${sceneCtx}\n\nDesign the app: "${name}" — ${desc}\nBlueprint format: {"id":"slug","name":"","icon":"","description":"","tagline":"","categories":["cat1","cat2"],"feedLabel":"Latest","feedItems":[{"title":"","subtitle":"","badge":"","description":"","stats":{"stat1":"val"},"actions":[{"label":"Action","prompt":"<instruction for AI>"}],"reviews":[{"user":"","text":""}]}]}`;
            try {
                const raw   = await sendPhoneRequest(sys, usr);
                const bp = _parseJsonRobust(raw, null);
                if (!bp) throw new Error('No JSON found');
                
                if (!bp.name) bp.name = name || 'Custom App';
                if (!bp.id) bp.id = bp.name.toLowerCase().replace(/\W+/g, '_') + '_' + Date.now();
                if (!bp.icon) bp.icon = icon || '📱';

                const ps2 = getPhoneState();
                ps2.phoneApps = ps2.phoneApps || [];
                ps2.phoneApps.push(bp);
                savePhoneState();
                _logPhoneActivity('app', name, 'out', `Installed app "${name}"`);
                _navigateTo(`installed_${bp.id}`);
            } catch (e) {
                screen.innerHTML = `<div class="rpg-phone-error">App creation failed: ${_escHtml(e.message)}</div>`;
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALLED CUSTOM APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderInstalledApp(appId, pageId, params, screen) {
    const ps  = getPhoneState();
    const app = (ps.phoneApps || []).find(a => a.id === appId);
    if (!app) { screen.innerHTML = `<div class="rpg-phone-error">App not found.</div>`; return; }

    _setNavTitle(app.name);

    if (pageId === 'home' || !pageId) {
        _logPhoneActivity('app', app.name, 'out', `Opened ${app.name}`);
        const cacheKey = `app_feed_${appId}`;
        if (ps.phoneCache[cacheKey]) { _renderAppFeed(screen, app, ps.phoneCache[cacheKey]); return; }
        const sceneCtx = _buildSceneContext(800);
        const sys = `You generate fresh content for the app "${app.name}" (${app.description || ''}) in this story world. Reply ONLY valid JSON array CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text! matching the app blueprint.`;
        const usr = `${sceneCtx}\n\nGenerate 5 content cards for ${app.name}. Use same structure as the blueprint feedItems: [{"title":"","subtitle":"","badge":"","description":"","stats":{},"actions":[{"label":"","prompt":""}],"reviews":[]}]`;
        try {
            const raw   = await sendPhoneRequest(sys, usr);
            const items  = _parseJsonRobust(raw, app.feedItems || []);
            ps.phoneCache[cacheKey] = items; savePhoneState();
            _renderAppFeed(screen, app, items);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderInstalledApp(appId, 'home', params, screen); });
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Feed failed: ${_escHtml(e.message)}</div>`; }
        return;
    }

    if (pageId === 'detail') {
        const item = params.item || {};
        _setNavTitle(item.title ? item.title.slice(0, 30) : app.name);
        _logPhoneActivity('app', app.name, 'in', `Viewed: "${_summarizeText(item.title, 60)}"`);

        const actionsHTML = (item.actions || []).map((a, i) =>
            `<button class="rpg-phone-app-btn-primary" data-action-idx="${i}">${_escHtml(a.label)}</button>`
        ).join('');
        const statsHTML = Object.entries(item.stats || {}).map(([k, v]) =>
            `<div class="rpg-phone-app-stat-box"><div class="rpg-phone-app-stat-label">${_escHtml(k)}</div><div class="rpg-phone-app-stat-val">${_escHtml(v)}</div></div>`
        ).join('');
        const reviewsHTML = (item.reviews || []).map(r =>
            `<div class="rpg-phone-app-review-item"><div class="rpg-phone-app-review-user">${_escHtml(r.user || '')}</div><div class="rpg-phone-app-review-text">${_escHtml(r.text || '')}</div></div>`
        ).join('');

        screen.innerHTML = `
<div class="rpg-phone-app-detail">
  <div class="rpg-phone-app-detail-header">
    <div class="rpg-phone-app-detail-title">${_escHtml(item.title || '')}</div>
    <div class="rpg-phone-app-detail-subtitle">${_escHtml(item.subtitle || '')}</div>
  </div>
  <div class="rpg-phone-app-detail-body">${_escHtml(item.description || '')}</div>
  ${statsHTML ? `<div class="rpg-phone-app-stats-grid">${statsHTML}</div>` : ''}
  <div class="rpg-phone-app-actions-row">${actionsHTML}</div>
  <div id="rpg_phone_app_action_feedback"></div>
  <div class="rpg-phone-app-input-box">
    <input type="text" class="rpg-phone-app-input" id="rpg_phone_custom_action_input" placeholder="Custom action…" autocomplete="off"/>
    <button class="rpg-phone-app-btn-secondary" id="rpg_phone_custom_action_send">Send</button>
  </div>
  ${reviewsHTML ? `<div class="rpg-phone-app-reviews">${reviewsHTML}</div>` : ''}
</div>`;

        const feedbackEl = screen.querySelector('#rpg_phone_app_action_feedback');
        const doAction = async (prompt, label) => {
            if (feedbackEl) feedbackEl.innerHTML = `<div class="rpg-phone-loading"><div class="rpg-phone-spinner"></div></div>`;
            _logPhoneActivity('app', app.name, 'out', `${label}: "${_summarizeText(item.title, 40)}"`);
            const sceneCtx = _buildSceneContext(800);
            const sys = `You are simulating the app "${app.name}" in this story world. Generate a brief, realistic in-app response to the user's action.`;
            const usr = `${sceneCtx}\n\nApp: ${app.name}\nContent: "${item.title}" — ${item.description || ''}\nUser action: "${label}"\n${prompt ? `Instruction: ${prompt}` : ''}\n\nRespond naturally as this app would.`;
            try {
                const reply = (await sendPhoneRequest(sys, usr))?.trim() || 'Action completed.';
                if (feedbackEl) feedbackEl.innerHTML = `<div class="rpg-phone-app-feedback-box">${_escHtml(reply)}</div>`;
                _logPhoneActivity('app', app.name, 'in', _summarizeText(reply, 100));
            } catch (e) {
                if (feedbackEl) feedbackEl.innerHTML = `<div class="rpg-phone-error">${_escHtml(e.message)}</div>`;
            }
        };

        screen.querySelectorAll('[data-action-idx]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.actionIdx, 10);
                const action = (item.actions || [])[idx];
                if (action) doAction(action.prompt, action.label);
            });
        });

        const sendCustom = async () => {
            const inp = document.getElementById('rpg_phone_custom_action_input');
            const text = inp?.value?.trim();
            if (!text || !inp) return;
            inp.value = '';
            await doAction('', text);
        };
        document.getElementById('rpg_phone_custom_action_send')?.addEventListener('click', sendCustom);
        document.getElementById('rpg_phone_custom_action_input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendCustom(); });
    }
}

function _renderAppFeed(screen, app, items) {
    const categories = app.categories || [];
    const tabsHTML = categories.map(c => `<button class="rpg-phone-app-tab">${_escHtml(c)}</button>`).join('');
    const cardsHTML = items.map((item, i) => `
<div class="rpg-phone-app-card" data-idx="${i}">
  <div class="rpg-phone-app-card-top">
    <div class="rpg-phone-app-card-title">${_escHtml(item.title || '')}</div>
    ${item.badge ? `<span class="rpg-phone-app-card-badge">${_escHtml(item.badge)}</span>` : ''}
  </div>
  ${item.subtitle ? `<div class="rpg-phone-app-card-subtitle">${_escHtml(item.subtitle)}</div>` : ''}
  ${item.description ? `<div class="rpg-phone-app-card-desc">${_escHtml(item.description.slice(0, 120))}…</div>` : ''}
  <div class="rpg-phone-app-card-footer">
    <span>${Object.entries(item.stats || {}).slice(0,2).map(([k,v]) => `${k}: ${v}`).join(' · ')}</span>
    <span class="rpg-phone-app-card-action">${(item.actions?.[0]?.label) || 'View →'}</span>
  </div>
</div>`).join('');

    screen.innerHTML = `
<div class="rpg-phone-custom-app">
  <div class="rpg-phone-app-banner">
    <div class="rpg-phone-app-header-left">
      <span class="rpg-phone-app-header-icon" style="display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px;">${_renderIcon(app.icon || '📱')}</span>
      <div>
        <div class="rpg-phone-app-header-title">${_escHtml(app.name)}</div>
        <div class="rpg-phone-app-header-tagline">${_escHtml(app.tagline || app.description || '')}</div>
      </div>
    </div>
  </div>
  ${tabsHTML ? `<div class="rpg-phone-app-tabs">${tabsHTML}</div>` : ''}
  <div class="rpg-phone-app-feed">${cardsHTML}</div>
</div>`;

    screen.querySelectorAll('.rpg-phone-app-card').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            _navigateTo(`installed_${app.id}`, 'detail', { item: items[idx] });
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderMessagesApp(pageId, params, screen) {
    _setNavTitle('Messages');
    const ps = getPhoneState();

    if (pageId === 'home' || !pageId) {
        ps.phoneUnread.messages = 0;
        savePhoneState();
        _updateNotificationBadge();
        _logPhoneActivity('sms', 'Messages', 'out', 'Opened Messages');

        const threads = Object.entries(ps.phoneMessages || {}).filter(([, msgs]) => msgs.length > 0);
        const threadsHTML = threads.length ? threads.map(([contact, msgs]) => {
            const last = msgs[msgs.length - 1];
            return `
<div class="rpg-phone-sms-thread-row" data-contact="${_escHtml(contact)}">
  <div class="rpg-phone-sms-avatar">${contact[0]?.toUpperCase() || '?'}</div>
  <div>
    <div class="rpg-phone-sms-contact-name">${_escHtml(contact)}</div>
    <div class="rpg-phone-sms-last-msg">${_escHtml(_summarizeText(last.text, 50))}</div>
  </div>
</div>`;
        }).join('') : '<p class="rpg-phone-muted" style="padding:16px">No conversations yet. Go to Contacts to start one.</p>';

        screen.innerHTML = `
<div class="rpg-phone-messages-header"><h3>Messages</h3></div>
${threadsHTML}`;

        screen.querySelectorAll('.rpg-phone-sms-thread-row').forEach(el => {
            el.addEventListener('click', () => _navigateTo('messages', 'thread', { contact: el.dataset.contact }));
        });
        return;
    }

    if (pageId === 'thread') {
        const contact = params.contact || 'Unknown';
        _setNavTitle(contact);
        _logPhoneActivity('sms', contact, 'in', `Opened SMS thread with ${contact}`);

        // Keyword trigger NPC lorebook
        _buildNpcCallContext(contact).catch(() => {});

        const msgs = ps.phoneMessages?.[contact] || [];
        const bubblesHTML = msgs.map(m => `
<div class="rpg-phone-sms-bubble ${m.direction === 'out' ? 'rpg-phone-sms-out' : 'rpg-phone-sms-in'}">
  ${_parsePhoneImages(_escHtml(m.text || ''))}
</div>`).join('');

        screen.innerHTML = `
<div class="rpg-phone-sms-thread">
  <div class="rpg-phone-sms-bubbles" id="rpg_phone_sms_bubbles">
    ${bubblesHTML || '<p class="rpg-phone-muted" style="text-align:center;padding:20px;">Start a conversation</p>'}
  </div>
  <div class="rpg-phone-sms-compose">
    <input type="text" class="rpg-phone-sms-input" id="rpg_phone_sms_input" placeholder="Message…" autocomplete="off"/>
    <button class="rpg-phone-sms-send-btn" id="rpg_phone_sms_send">▶</button>
  </div>
</div>`;

        const bubbles = document.getElementById('rpg_phone_sms_bubbles');
        if (bubbles) bubbles.scrollTop = bubbles.scrollHeight;
        _bindPhoneImages(screen);

        const sendMsg = async () => {
            const input  = document.getElementById('rpg_phone_sms_input');
            const text   = input?.value?.trim();
            if (!text || !input) return;
            input.value  = '';
            _markPhoneUsed();

            const outBubble = document.createElement('div');
            outBubble.className = 'rpg-phone-sms-bubble rpg-phone-sms-out';
            outBubble.innerHTML = _parsePhoneImages(_escHtml(text));
            bubbles?.appendChild(outBubble);
            if (bubbles) bubbles.scrollTop = bubbles.scrollHeight;

            const timeInfo = getInWorldTimeInfo();
            if (!ps.phoneMessages[contact]) ps.phoneMessages[contact] = [];
            ps.phoneMessages[contact].push({ text, direction: 'out', timestamp: Date.now(), inWorldMinutes: timeInfo.totalMinutes, inWorldTimeStr: timeInfo.clockOnly });
            _logPhoneActivity('sms', contact, 'out', text);
            savePhoneState();

            try {
                const ctx = await _buildNpcCallContext(contact);
                const sys = `You are roleplaying as ${contact} in a text message conversation with ${ctx.pcName}.

${ctx.cardBlock ? `## WORLD & ACTIVE CARD CONTEXT\n${ctx.cardBlock}\n\n` : ''}${ctx.npcBlock ? `## WHO YOU ARE\n${ctx.npcBlock}\n\n` : ''}${ctx.pcBlock ? `## WHO YOU ARE TALKING TO (${ctx.pcName})\n${ctx.pcBlock}\n\n` : ''}## RULES
- Stay fully in character as ${contact}. Speak how this character would actually speak.
- You ONLY know what ${contact} would realistically know. Do NOT reference events not known to ${contact}.
- Do NOT mention game stats, HP, combat mechanics, gear lists, or anything meta.
- This is a TEXT MESSAGE — keep it casual and natural. 1–3 short sentences max.
- Reply with ONLY the message text. No labels, no quotes.`;
                const usr = `${ctx.chatContext ? ctx.chatContext + '\n\n' : ''}${ctx.threadHistory ? '## CONVERSATION SO FAR\n' + ctx.threadHistory + '\n\n' : ''}${ctx.pcName} just texted: "${text}"\n${contact} replies:`;
                const reply = (await sendPhoneRequest(sys, usr)).trim();

                const timeInfo2 = getInWorldTimeInfo();
                ps.phoneMessages[contact].push({ text: reply, direction: 'in', timestamp: Date.now(), inWorldMinutes: timeInfo2.totalMinutes, inWorldTimeStr: timeInfo2.clockOnly });
                _logPhoneActivity('sms', contact, 'in', reply);
                savePhoneState();

                const inBubble = document.createElement('div');
                inBubble.className = 'rpg-phone-sms-bubble rpg-phone-sms-in';
                inBubble.innerHTML = _parsePhoneImages(_escHtml(reply));
                bubbles?.appendChild(inBubble);
                if (bubbles) bubbles.scrollTop = bubbles.scrollHeight;
                _bindPhoneImages(screen);
            } catch (e) { console.warn('[SillyPhone] SMS reply failed:', e); }
        };

        document.getElementById('rpg_phone_sms_send')?.addEventListener('click', sendMsg);
        document.getElementById('rpg_phone_sms_input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DIALER APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderDialerApp(pageId, params, screen) {
    _setNavTitle('Phone');
    const ps = getPhoneState();

    if (pageId === 'home' || !pageId) {
        ps.phoneUnread.calls = 0;
        savePhoneState();
        _updateNotificationBadge();
        _logPhoneActivity('call', 'Dialer', 'out', 'Opened Dialer');

        const recentHTML = (ps.phoneCallLog || []).slice(-5).reverse().map(c => `
<div class="rpg-phone-calllog-row" data-contact="${_escHtml(c.name || '')}">
  <span class="rpg-phone-calllog-dir">${c.direction === 'out' ? '📞' : '📲'}</span>
  <div>
    <div class="rpg-phone-calllog-name">${_escHtml(c.name || '')}</div>
    <div class="rpg-phone-calllog-meta">${c.duration || ''} · ${c.inWorldTimeStr || ''}</div>
  </div>
</div>`).join('') || '<p class="rpg-phone-muted" style="padding:8px 0">No recent calls</p>';

        screen.innerHTML = `
<div class="rpg-phone-dialer">
  <div class="rpg-phone-dialer-display" id="rpg_phone_dialer_display"></div>
  <div class="rpg-phone-dialer-grid">
    ${['1','2','3','4','5','6','7','8','9','*','0','#'].map(k =>
      `<button class="rpg-phone-dialpad-key" data-digit="${k}">${k}</button>`
    ).join('')}
  </div>
  <div class="rpg-phone-dialer-actions">
    <button class="rpg-phone-delete-btn" id="rpg_phone_dialer_del">⌫</button>
    <button class="rpg-phone-call-btn" id="rpg_phone_dialer_call">📞</button>
  </div>
  <div class="rpg-phone-calllog">${recentHTML}</div>
</div>`;

        const display = document.getElementById('rpg_phone_dialer_display');
        screen.querySelectorAll('.rpg-phone-dialpad-key').forEach(btn => {
            btn.addEventListener('click', () => { if (display) display.textContent += btn.dataset.digit; });
        });
        document.getElementById('rpg_phone_dialer_del')?.addEventListener('click', () => {
            if (display) display.textContent = display.textContent.slice(0, -1);
        });
        document.getElementById('rpg_phone_dialer_call')?.addEventListener('click', () => {
            const contact = display?.textContent.trim();
            if (contact) _navigateTo('dialer', 'call', { contact });
        });
        screen.querySelectorAll('.rpg-phone-calllog-row').forEach(el => {
            el.addEventListener('click', () => _navigateTo('dialer', 'call', { contact: el.dataset.contact }));
        });
        return;
    }

    if (pageId === 'call') {
        const contact = params.contact || 'Unknown';
        _setNavTitle(contact);
        _logPhoneActivity('call', contact, 'out', `Called ${contact}`);

        let callEnded  = false;
        let callSeconds = 0;
        let timerInterval;

        screen.innerHTML = `
<div class="rpg-phone-call-screen">
  <div class="rpg-phone-call-avatar">${contact[0]?.toUpperCase() || '?'}</div>
  <div class="rpg-phone-call-name">${_escHtml(contact)}</div>
  <div class="rpg-phone-call-status" id="rpg_phone_call_status">Calling…</div>
  <div class="rpg-phone-call-timer" id="rpg_phone_call_timer">0:00</div>
  <div class="rpg-phone-call-transcript" id="rpg_phone_call_transcript"></div>
  <div class="rpg-phone-call-input-row">
    <input type="text" class="rpg-phone-sms-input" id="rpg_phone_call_say" placeholder="Say something…" autocomplete="off"/>
    <button class="rpg-phone-sms-send-btn" id="rpg_phone_call_say_btn">▶</button>
  </div>
  <div class="rpg-phone-call-controls">
    <button class="rpg-phone-call-end-btn" id="rpg_phone_call_end">📵</button>
  </div>
</div>`;

        const statusEl   = document.getElementById('rpg_phone_call_status');
        const transcriptEl = document.getElementById('rpg_phone_call_transcript');
        const timerEl    = document.getElementById('rpg_phone_call_timer');
        const inputRow   = screen.querySelector('.rpg-phone-call-input-row');

        // Start call timer after 1.5s
        setTimeout(async () => {
            if (callEnded) return;
            if (statusEl) statusEl.textContent = `On a call with ${contact}`;
            timerInterval = setInterval(() => {
                callSeconds++;
                const m = Math.floor(callSeconds / 60);
                const s = callSeconds % 60;
                if (timerEl) timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
            }, 1000);

            try {
                const ctx = await _buildNpcCallContext(contact);
                const sys = `You are roleplaying as ${contact} answering a phone call from ${ctx.pcName}.

${ctx.cardBlock ? `## WORLD & ACTIVE CARD CONTEXT\n${ctx.cardBlock}\n\n` : ''}${ctx.npcBlock ? `## WHO YOU ARE\n${ctx.npcBlock}\n\n` : ''}${ctx.pcBlock ? `## WHO YOU ARE TALKING TO (${ctx.pcName})\n${ctx.pcBlock}\n\n` : ''}## RULES
- Stay fully in character as ${contact}.
- This is a SPOKEN phone call — speak naturally. 1–2 sentences max per turn.
- Output ONLY the spoken words. No dialogue tags, no asterisks, no quotes.`;
                const usr = `${ctx.chatContext ? ctx.chatContext + '\n\n' : ''}*${contact}'s phone rings. ${contact} picks up.*\n${contact} says:`;
                const greeting = (await sendPhoneRequest(sys, usr)).trim();
                if (transcriptEl && !callEnded) {
                    const line = document.createElement('div');
                    line.className = 'rpg-phone-call-line rpg-phone-call-npc';
                    line.textContent = `${contact}: ${greeting}`;
                    transcriptEl.appendChild(line);
                }
            } catch (e) { console.warn('[SillyPhone] Call greeting failed:', e); }
        }, 1500);

        const saySomething = async () => {
            const input = document.getElementById('rpg_phone_call_say');
            const text  = input?.value?.trim();
            if (!text || !input || callEnded) return;
            input.value = '';
            const { pcName } = _getPlayerCharacterInfo();
            const userLine = document.createElement('div');
            userLine.className = 'rpg-phone-call-line rpg-phone-call-user';
            userLine.textContent = `${pcName}: ${text}`;
            transcriptEl?.appendChild(userLine);
            if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;

            try {
                const ctx = await _buildNpcCallContext(contact);
                const allLines = Array.from(transcriptEl?.children || []).map(el => el.textContent).join('\n');
                const sys = `You are roleplaying as ${contact} on a phone call with ${ctx.pcName}.

${ctx.cardBlock ? `## WORLD & ACTIVE CARD CONTEXT\n${ctx.cardBlock}\n\n` : ''}${ctx.npcBlock ? `## WHO YOU ARE\n${ctx.npcBlock}\n\n` : ''}${ctx.pcBlock ? `## WHO YOU ARE TALKING TO (${ctx.pcName})\n${ctx.pcBlock}\n\n` : ''}## RULES
- Stay fully in character as ${contact}. Speak naturally in 1–2 sentences.
- Output ONLY spoken dialogue. No tags, no actions, no asterisks, no quotes.`;
                const usr = `${ctx.chatContext ? ctx.chatContext + '\n\n' : ''}## CALL TRANSCRIPT SO FAR\n${allLines}\n\n${contact} says:`;
                const reply = (await sendPhoneRequest(sys, usr)).trim();
                if (transcriptEl && !callEnded) {
                    const line = document.createElement('div');
                    line.className = 'rpg-phone-call-line rpg-phone-call-npc';
                    line.textContent = `${contact}: ${reply}`;
                    transcriptEl.appendChild(line);
                    transcriptEl.scrollTop = transcriptEl.scrollHeight;
                }
            } catch (e) { console.warn('[SillyPhone] Call reply failed:', e); }
        };

        document.getElementById('rpg_phone_call_say_btn')?.addEventListener('click', saySomething);
        document.getElementById('rpg_phone_call_say')?.addEventListener('keydown', e => { if (e.key === 'Enter') saySomething(); });

        document.getElementById('rpg_phone_call_end')?.addEventListener('click', () => {
            callEnded = true;
            clearInterval(timerInterval);
            const dur = `${Math.floor(callSeconds/60)}:${String(callSeconds%60).padStart(2,'0')}`;
            if (statusEl) statusEl.textContent = 'Call ended';
            if (inputRow) inputRow.style.display = 'none';

            const transcriptLines = Array.from(transcriptEl?.children || []).map(el => el.textContent.trim()).filter(Boolean);
            const callSummary = transcriptLines.length > 0
                ? `Call with ${contact} (${dur}) — Dialogue: ${transcriptLines.join(' | ')}`
                : `Call with ${contact} (${dur})`;

            const timeInfo = getInWorldTimeInfo();
            if (!Array.isArray(ps.phoneCallLog)) ps.phoneCallLog = [];
            ps.phoneCallLog.push({ name: contact, duration: dur, direction: 'out', timestamp: Date.now(), inWorldMinutes: timeInfo.totalMinutes, inWorldTimeStr: timeInfo.clockOnly, transcript: transcriptLines });
            _logPhoneActivity('call', contact, 'out', callSummary);
            savePhoneState();
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderContactsApp(pageId, params, screen) {
    _setNavTitle('Contacts');
    const ps = getPhoneState();

    if (pageId === 'home' || !pageId) {
        // Auto-import NPC contacts from lorebook if none yet
        if ((ps.phoneContacts || []).length === 0) {
            try {
                const ctx = getSTContext();
                if (ctx.characters) {
                    for (const char of Object.values(ctx.characters)) {
                        if (char?.name && char.name !== ctx.name2 && !ps.phoneContacts.find(c => c.name === char.name)) {
                            ps.phoneContacts.push({ name: char.name, relation: 'Character' });
                        }
                    }
                    savePhoneState();
                }
            } catch {}
        }

        const contacts = [...(ps.phoneContacts || [])].sort((a, b) => a.name.localeCompare(b.name));
        _logPhoneActivity('contact', 'Contacts', 'out', `Opened Contacts (${contacts.length} saved)`);

        const listHTML = contacts.length ? contacts.map(c => `
<div class="rpg-phone-contact-row" data-contact="${_escHtml(c.name)}">
  <div class="rpg-phone-contact-avatar">${c.name[0]?.toUpperCase() || '?'}</div>
  <div class="rpg-phone-contact-info">
    <div class="rpg-phone-contact-name">${_escHtml(c.name)}</div>
    ${c.relation ? `<div class="rpg-phone-contact-relation">${_escHtml(c.relation)}</div>` : ''}
  </div>
</div>`).join('') : '<p class="rpg-phone-muted" style="padding:16px 0;text-align:center;">No contacts saved yet.</p>';

        screen.innerHTML = `
<div class="rpg-phone-contacts">
  <div class="rpg-phone-contacts-header">
    <input type="text" class="rpg-phone-search-input" id="rpg_phone_contact_search" placeholder="Search contacts…"/>
  </div>
  <button class="rpg-phone-btn rpg-phone-btn-secondary" id="rpg_phone_add_contact_btn" style="margin-bottom:12px;">➕ Add Contact</button>
  <div class="rpg-phone-contact-list" id="rpg_phone_contact_list">${listHTML}</div>
</div>`;

        screen.querySelectorAll('.rpg-phone-contact-row').forEach(el => {
            el.addEventListener('click', () => _navigateTo('contacts', 'detail', { contact: el.dataset.contact }));
        });
        screen.querySelector('#rpg_phone_contact_search')?.addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            screen.querySelectorAll('.rpg-phone-contact-row').forEach(row => {
                row.style.display = row.dataset.contact.toLowerCase().includes(q) ? '' : 'none';
            });
        });
        document.getElementById('rpg_phone_add_contact_btn')?.addEventListener('click', () => _navigateTo('contacts', 'add'));
        return;
    }

    if (pageId === 'detail') {
        const contact = params.contact || '';
        _setNavTitle(contact);
        const c = ps.phoneContacts?.find(x => x.name === contact) || { name: contact };
        _logPhoneActivity('contact', contact, 'in', `Viewed contact info for ${contact}${c.relation ? ` (${c.relation})` : ''}`);

        screen.innerHTML = `
<div class="rpg-phone-contact-detail">
  <div class="rpg-phone-contact-detail-avatar">${contact[0]?.toUpperCase() || '?'}</div>
  <h3 class="rpg-phone-contact-detail-name">${_escHtml(contact)}</h3>
  ${c.relation ? `<p class="rpg-phone-muted" style="margin-top:-4px;">${_escHtml(c.relation)}</p>` : ''}
  <div class="rpg-phone-contact-actions">
    <button class="rpg-phone-btn rpg-phone-btn-primary" data-action="call">📞 Call</button>
    <button class="rpg-phone-btn rpg-phone-btn-secondary" data-action="text">💬 Text</button>
  </div>
  <div style="margin-top:16px;width:100%;">
    <button class="rpg-phone-btn rpg-phone-btn-danger" id="rpg_phone_delete_contact_btn">🗑️ Delete Contact</button>
  </div>
</div>`;

        screen.querySelector('[data-action="call"]')?.addEventListener('click', () => _navigateTo('dialer', 'call', { contact }));
        screen.querySelector('[data-action="text"]')?.addEventListener('click', () => _navigateTo('messages', 'thread', { contact }));
        document.getElementById('rpg_phone_delete_contact_btn')?.addEventListener('click', () => {
            if (!confirm(`Delete contact "${contact}"?`)) return;
            const idx = ps.phoneContacts.findIndex(c => c.name === contact);
            if (idx !== -1) { ps.phoneContacts.splice(idx, 1); savePhoneState(); }
            _navigateTo('contacts');
        });
        return;
    }

    if (pageId === 'add') {
        _setNavTitle('Add Contact');
        screen.innerHTML = `
<div class="rpg-phone-contact-add">
  <h3>Add Contact</h3>
  <input type="text" class="rpg-phone-input-small" id="rpg_phone_new_contact_name" placeholder="Name…" autocomplete="off"/>
  <input type="text" class="rpg-phone-input-small" id="rpg_phone_new_contact_rel" placeholder="Relation (e.g. friend, colleague)…" autocomplete="off"/>
  <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_save_contact_btn">Save Contact</button>
</div>`;
        document.getElementById('rpg_phone_save_contact_btn')?.addEventListener('click', () => {
            const name = document.getElementById('rpg_phone_new_contact_name')?.value?.trim();
            const rel  = document.getElementById('rpg_phone_new_contact_rel')?.value?.trim();
            if (!name) { alert('Please enter a name.'); return; }
            if (!ps.phoneContacts.find(c => c.name === name)) {
                ps.phoneContacts.push({ name, relation: rel || '' });
                savePhoneState();
                _logPhoneActivity('contact', name, 'out', `Saved contact: ${name}${rel ? ` (${rel})` : ''}`);
            }
            _navigateTo('contacts');
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA APP
// ─────────────────────────────────────────────────────────────────────────────

function _renderCameraApp(pageId, params, screen) {
    _setNavTitle('Camera');
    _logPhoneActivity('camera', 'Camera', 'out', 'Opened Camera');

    screen.innerHTML = `
<div class="rpg-phone-camera">
  <div class="rpg-phone-camera-viewfinder">
    <div class="rpg-phone-camera-crosshair"></div>
    <div class="rpg-phone-camera-hint">Aim and capture</div>
  </div>
  <div class="rpg-phone-camera-modes">
    <button class="rpg-phone-camera-mode-btn" data-mode="selfie">🤳 Selfie</button>
    <button class="rpg-phone-camera-mode-btn" data-mode="scene">📸 Scene</button>
  </div>
  <div style="display:flex;gap:8px;width:100%">
    <input type="text" class="rpg-phone-input-small" id="rpg_phone_custom_photo_desc" placeholder="Custom photo description…" style="flex:1" autocomplete="off"/>
    <button class="rpg-phone-btn-small" id="rpg_phone_custom_photo_btn">📷</button>
  </div>
  <div id="rpg_phone_camera_status" style="font-size:13px;color:rgba(255,255,255,0.5);min-height:20px;"></div>
</div>`;

    const statusEl = document.getElementById('rpg_phone_camera_status');
    screen.querySelectorAll('.rpg-phone-camera-mode-btn').forEach(btn => {
        btn.addEventListener('click', async () => _capturePhoto(btn.dataset.mode, null, statusEl));
    });
    document.getElementById('rpg_phone_custom_photo_btn')?.addEventListener('click', async () => {
        const desc = document.getElementById('rpg_phone_custom_photo_desc')?.value?.trim();
        await _capturePhoto('custom', desc, statusEl);
    });
}

async function _capturePhoto(mode, customDesc, statusEl) {
    _markPhoneUsed();
    if (statusEl) statusEl.textContent = '📷 Framing photo…';

    try {
        const s = getSettings();
        const ctx = getSTContext();
        const { pcName } = _getPlayerCharacterInfo();

        let cardWorldInfo = '';
        if (s.includeCardContext !== false) {
            const cardInfo = _getActiveCardInfo();
            const cardDesc = cardInfo?.cardData?.description || cardInfo?.cardData?.data?.description || '';
            if (cardDesc) cardWorldInfo = cardDesc.slice(0, 300).replace(/[\r\n]+/g, ' ').trim();
        }

        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const recentMemo = chat.slice(-5).map(m => String(m.mes || m.content || '')).join('\n');
        const locMatch = recentMemo.match(/\[LOCATION\]([\s\S]*?)\[\/LOCATION\]/i);
        const locInfo  = locMatch ? locMatch[1].slice(0, 200) : '';

        let prompt = '';
        let photoLabel = '';

        if (mode === 'selfie') {
            photoLabel = `Selfie (${pcName || 'Me'})`;
            const charMatch = recentMemo.match(/\[CHARACTER\]([\s\S]*?)\[\/CHARACTER\]/i);
            const charInfo  = charMatch ? charMatch[1].slice(0, 300) : '';
            prompt = `Smartphone front-facing selfie portrait photo of ${pcName || 'character'}. Appearance: ${charInfo || 'young adult'}. Realistic candid selfie, natural lighting, modern smartphone camera.`;
        } else if (mode === 'scene') {
            photoLabel = 'Scene Photo';
            const settingCtx = locInfo || cardWorldInfo || 'modern environment';
            const timeStr = getInWorldTimeInfo().rawTime || 'daytime';
            prompt = `Realistic smartphone photo of current scene. Environment: ${settingCtx}. Time: ${timeStr}. Candid photography, natural lighting.`;
        } else {
            photoLabel = customDesc ? `Photo: ${customDesc.slice(0, 30)}` : 'Custom Photo';
            prompt = `Realistic smartphone photo: ${customDesc}. Candid photography, sharp detail, natural lighting.`;
        }

        if (statusEl) statusEl.textContent = '🎨 Generating photo…';

        let imageUrl = null;
        try {
            if (ctx.executeSlashCommandsWithOptions) {
                const s = getSettings();
                const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const cmd = (s.imageGenCommand || '/imagine quiet=true "{{prompt}}"').replace('{{prompt}}', escaped);
                const result  = await ctx.executeSlashCommandsWithOptions(cmd);
                if (result?.pipe) imageUrl = result.pipe;
            }
        } catch (genErr) { console.warn('[SillyPhone] Camera generate failed:', genErr); }

        const timeInfo = getInWorldTimeInfo();
        const ps = getPhoneState();
        if (ps) {
            if (!Array.isArray(ps.phoneGallery)) ps.phoneGallery = [];
            ps.phoneGallery.push({ id: `photo_${Date.now()}`, prompt, label: photoLabel, imageUrl: imageUrl || null, mode, inWorldMinutes: timeInfo.totalMinutes, inWorldTimeStr: timeInfo.clockOnly, turnNumber: chat.length, timestamp: Date.now() });
            const photoDesc = mode === 'selfie' ? 'selfie' : mode === 'scene' ? 'scene photo' : (customDesc ? `photo: "${customDesc}"` : 'photo');
            _logPhoneActivity('camera', 'Camera', 'out', `Took a ${photoDesc}`);
            savePhoneState();
        }

        if (statusEl) statusEl.textContent = imageUrl ? '✅ Photo saved to Gallery!' : '📷 Photo captured (no image generator configured).';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);

    } catch (e) {
        console.warn('[SillyPhone] _capturePhoto failed:', e);
        if (statusEl) statusEl.textContent = `❌ Failed: ${e.message}`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GALLERY APP
// ─────────────────────────────────────────────────────────────────────────────

function _renderGalleryApp(pageId, params, screen) {
    _setNavTitle('Gallery');
    const ps = getPhoneState();
    const gallery = ps?.phoneGallery || [];
    _logPhoneActivity('gallery', 'Gallery', 'out', `Opened Gallery (${gallery.length} photos)`);

    if (pageId === 'home' || !pageId) {
        if (!gallery.length) {
            screen.innerHTML = `<div class="rpg-phone-gallery-empty"><span>📷</span><p>No photos yet. Use the Camera app.</p></div>`;
            return;
        }
        const items = gallery.map((photo, i) => {
            const thumb = photo.imageUrl
                ? `<img src="${_escHtml(photo.imageUrl)}" class="rpg-phone-gallery-thumb" loading="lazy"/>`
                : `<div class="rpg-phone-gallery-placeholder">📷</div>`;
            return `
<div class="rpg-phone-gallery-item" data-idx="${i}" role="button" tabindex="0">
  ${thumb}
  <div class="rpg-phone-gallery-label">${_escHtml(photo.label || photo.mode || 'photo')}</div>
</div>`;
        }).join('');
        screen.innerHTML = `<div class="rpg-phone-gallery-grid">${items}</div>`;
        screen.querySelectorAll('.rpg-phone-gallery-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx, 10);
                if (gallery[idx]) _navigateTo('gallery', 'photo', { photo: gallery[idx] });
            });
        });
        return;
    }

    if (pageId === 'photo') {
        const photo = params.photo || {};
        _setNavTitle(photo.label || 'Photo');
        _logPhoneActivity('gallery', 'Gallery', 'in', `Viewed photo: "${photo.label || 'photo'}"`);
        const imgHTML = photo.imageUrl
            ? `<img src="${_escHtml(photo.imageUrl)}" class="rpg-phone-photo-full" style="cursor:pointer" onclick="window.open(this.src,'_blank')"/>`
            : `<div class="rpg-phone-gallery-placeholder-lg">📷</div>`;
        screen.innerHTML = `
${imgHTML}
<div class="rpg-phone-photo-caption">
  <strong>${_escHtml(photo.label || '')}</strong><br/>
  ${photo.inWorldTimeStr ? `📍 ${_escHtml(photo.inWorldTimeStr)}` : ''}<br/>
  <span class="rpg-phone-muted">${_escHtml(photo.prompt ? photo.prompt.slice(0, 100) + '…' : '')}</span>
</div>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IN-PHONE SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

function _renderPhoneSettingsApp(pageId, params, screen) {
    _setNavTitle('Settings');
    _logPhoneActivity('app', 'Settings', 'out', 'Opened Phone Settings');
    const s = getSettings();

    screen.innerHTML = `
<div class="rpg-phone-settings-app">
  <h3>SillyPhone Settings</h3>
  <label class="rpg-phone-settings-row">
    <span style="flex:1">Phone Size (%)</span>
    <input type="range" id="rpg_phone_scale" min="50" max="200" value="${s.phoneScale || 100}"/>
    <span id="rpg_phone_scale_lbl" style="width:40px;text-align:right">${s.phoneScale || 100}%</span>
  </label>
  <label class="rpg-phone-settings-row">
    <span style="flex:1">Laptop Size (%)</span>
    <input type="range" id="rpg_laptop_scale" min="50" max="200" value="${s.laptopScale || 100}"/>
    <span id="rpg_laptop_scale_lbl" style="width:40px;text-align:right">${s.laptopScale || 100}%</span>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Include active card & world context in AI prompts</span>
    <input type="checkbox" id="rpg_phone_card_ctx_toggle" ${s.includeCardContext !== false ? 'checked' : ''}/>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Multihog Mode (Read PC data from Multihog framework)</span>
    <input type="checkbox" id="rpg_phone_multihog_toggle" ${s.multihogMode ? 'checked' : ''}/>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Auto-send "Put down phone" chat message</span>
    <input type="checkbox" id="rpg_phone_autoputdown_toggle" ${s.autoPutDownMessage !== false ? 'checked' : ''}/>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Place "Put down" message in textbox instead of sending directly</span>
    <input type="checkbox" id="rpg_phone_putdown_textbox_toggle" ${s.putDownMessageToTextbox ? 'checked' : ''}/>
  </label>
  <label class="rpg-phone-settings-row">
    <span style="flex:1">Image Gen Slash Command<br><small style="color:rgba(255,255,255,0.5)">Use {{prompt}} for prompt insertion</small></span>
    <input type="text" id="rpg_phone_img_cmd" class="rpg-phone-input-small" style="width:140px;" value="${_escHtml(s.imageGenCommand || '/imagine quiet=true "{{prompt}}"')}"/>
  </label>
  <label class="rpg-phone-settings-row" style="flex-direction:column; align-items:stretch; gap:4px;">
    <span style="flex:1">AI Image Prompt Instructions<br><small style="color:rgba(255,255,255,0.5)">How AI should write the image prompt</small></span>
    <textarea id="rpg_phone_img_inst" rows="3" class="rpg-phone-input-small" style="width:100%;resize:vertical;background:var(--SmartThemeDarkerColor, #121212);color:var(--SmartThemeBodyColor, #fff);">${_escHtml(s.imagePromptInstruction || 'detailed visual description of the photo if applicable, else empty string')}</textarea>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Context depth (events in AI context)</span>
    <input type="range" min="1" max="100" value="${s.contextDepth || 20}" id="rpg_phone_ctx_depth_slider"/>
    <span id="rpg_phone_ctx_depth_val">${s.contextDepth || 20}</span>
  </label>
  <label class="rpg-phone-settings-row">
    <span>NPC contact chance per turn (%)</span>
    <input type="range" min="0" max="40" value="${s.npcContactChance ?? 8}" id="rpg_phone_npc_chance_slider"/>
    <span id="rpg_phone_npc_chance_val">${s.npcContactChance ?? 8}%</span>
  </label>
  <button class="rpg-phone-btn rpg-phone-btn-danger" id="rpg_phone_clear_history_btn">🗑️ Clear Phone History</button>
  <button class="rpg-phone-btn rpg-phone-btn-danger" id="rpg_phone_reset_all_btn">⚠️ Reset All Phone Data</button>
</div>`;

    
    const inPhoneScale = document.getElementById('rpg_phone_scale');
    const inPhoneLbl = document.getElementById('rpg_phone_scale_lbl');
    inPhoneScale?.addEventListener('input', () => {
        s.phoneScale = parseInt(inPhoneScale.value, 10);
        if (inPhoneLbl) inPhoneLbl.textContent = `${s.phoneScale}%`;
        saveSettings();
        if (_isOpen && !globalThis._rpgLaptopMode) { _isOpen = false; openPhone(); }
    });
    
    const inLaptopScale = document.getElementById('rpg_laptop_scale');
    const inLaptopLbl = document.getElementById('rpg_laptop_scale_lbl');
    inLaptopScale?.addEventListener('input', () => {
        s.laptopScale = parseInt(inLaptopScale.value, 10);
        if (inLaptopLbl) inLaptopLbl.textContent = `${s.laptopScale}%`;
        saveSettings();
        if (_isOpen && globalThis._rpgLaptopMode) { _isOpen = false; openPhone(); }
    });
    
    document.getElementById('rpg_phone_card_ctx_toggle')?.addEventListener('change', e => { s.includeCardContext = e.target.checked; saveSettings(); });
    document.getElementById('rpg_phone_multihog_toggle')?.addEventListener('change', e => { s.multihogMode = e.target.checked; saveSettings(); });
    document.getElementById('rpg_phone_autoputdown_toggle')?.addEventListener('change', e => { s.autoPutDownMessage = e.target.checked; saveSettings(); });
    document.getElementById('rpg_phone_putdown_textbox_toggle')?.addEventListener('change', e => { s.putDownMessageToTextbox = e.target.checked; saveSettings(); });
    document.getElementById('rpg_phone_img_cmd')?.addEventListener('change', e => { s.imageGenCommand = e.target.value; saveSettings(); });
    document.getElementById('rpg_phone_img_inst')?.addEventListener('change', e => { s.imagePromptInstruction = e.target.value; saveSettings(); });
    const depthSlider = document.getElementById('rpg_phone_ctx_depth_slider');
    const depthVal    = document.getElementById('rpg_phone_ctx_depth_val');
    depthSlider?.addEventListener('input', () => { s.contextDepth = parseInt(depthSlider.value, 10); if (depthVal) depthVal.textContent = depthSlider.value; saveSettings(); });
    const chanceSlider = document.getElementById('rpg_phone_npc_chance_slider');
    const chanceVal    = document.getElementById('rpg_phone_npc_chance_val');
    chanceSlider?.addEventListener('input', () => { s.npcContactChance = parseInt(chanceSlider.value, 10); if (chanceVal) chanceVal.textContent = `${chanceSlider.value}%`; saveSettings(); });
    document.getElementById('rpg_phone_clear_history_btn')?.addEventListener('click', () => {
        const ps = getPhoneState();
        if (ps) { ps.phoneHistory = []; ps.phoneUnread = { messages: 0, calls: 0 }; savePhoneState(); _updateNotificationBadge(); alert('Phone history cleared.'); }
    });
    document.getElementById('rpg_phone_reset_all_btn')?.addEventListener('click', () => {
        if (!confirm('Reset ALL phone data for this chat? (contacts, messages, apps, gallery, history)')) return;
        const id = getChatId();
        const s2 = getSettings();
        if (s2.chatData && s2.chatData[id]) { delete s2.chatData[id]; saveSettings(); _updateNotificationBadge(); _navigateHome(); }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension settings panel (ST sidebar)
// ─────────────────────────────────────────────────────────────────────────────

function _buildSettingsHTML() {
    const s = getSettings();
    
    return `
<div id="sillyphone_settings" class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>📱 SillyPhone</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">

    <div class="inline-drawer">
      <div class="inline-drawer-toggle" style="display:flex; justify-content:space-between; align-items:center; padding:6px 4px; margin-top:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.1);">
        <b>⚙️ General</b>
        <div class="inline-drawer-icon fa-solid fa-chevron-down down" style="opacity:0.5; font-size:12px;"></div>
      </div>
      <div class="inline-drawer-content" style="padding-top:8px;">
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_enabled_cb" ${s.enabled ? 'checked' : ''}/> Enable SillyPhone</label>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_multihog_cb" ${s.multihogMode ? 'checked' : ''}/> Enable Multihog Mode (Read PC data)</label>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_phone_mode_cb" ${s.phoneMode ? 'checked' : ''}/> Phone Mode (Mobile layout support)</label>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label style="flex:1">Phone Size (%)</label>
          <input type="range" id="sp_phone_scale" min="50" max="200" value="${s.phoneScale || 100}"/>
          <span id="sp_phone_scale_label">${s.phoneScale || 100}%</span>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label style="flex:1">Laptop Size (%)</label>
          <input type="range" id="sp_laptop_scale" min="50" max="200" value="${s.laptopScale || 100}"/>
          <span id="sp_laptop_scale_label">${s.laptopScale || 100}%</span>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_auto_nav_cb" ${s.experimentalAutoNavigate ? 'checked' : ''}/> [Experimental] Auto-Navigate on Phone Action</label>
        </div>
      </div>
    </div>

    <div class="inline-drawer">
      <div class="inline-drawer-toggle" style="display:flex; justify-content:space-between; align-items:center; padding:6px 4px; margin-top:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.1);">
        <b>💬 Chat & Actions</b>
        <div class="inline-drawer-icon fa-solid fa-chevron-down down" style="opacity:0.5; font-size:12px;"></div>
      </div>
      <div class="inline-drawer-content" style="padding-top:8px;">
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_card_ctx_cb" ${s.includeCardContext !== false ? 'checked' : ''}/> Include Active Card Context in AI prompts</label>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_autoputdown_cb" ${s.autoPutDownMessage !== false ? 'checked' : ''}/> Auto-send "Put down phone" message to chat</label>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label><input type="checkbox" id="sp_putdown_textbox_cb" ${s.putDownMessageToTextbox ? 'checked' : ''}/> Place "Put down" message in textbox instead of sending</label>
        </div>
      </div>
    </div>

    <div class="inline-drawer">
      <div class="inline-drawer-toggle" style="display:flex; justify-content:space-between; align-items:center; padding:6px 4px; margin-top:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.1);">
        <b>👽 Reddit</b>
        <div class="inline-drawer-icon fa-solid fa-chevron-down down" style="opacity:0.5; font-size:12px;"></div>
      </div>
      <div class="inline-drawer-content" style="padding-top:8px;">
        <div class="sillyphone-setting-row" style="margin-bottom:8px; flex-direction:column; align-items:flex-start; gap:4px;">
          <label>Initial Feed Posts (Range or Number)</label>
          <input type="text" id="sp_reddit_feed_count" value="${s.redditFeedPostCount || '8-12'}" style="width:100%; background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.1); color:white; padding:4px 8px; border-radius:4px;" />
        </div>
      </div>
    </div>
    
    <div class="inline-drawer">
      <div class="inline-drawer-toggle" style="display:flex; justify-content:space-between; align-items:center; padding:6px 4px; margin-top:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.1);">
        <b>🖼️ Image Generation</b>
        <div class="inline-drawer-icon fa-solid fa-chevron-down down" style="opacity:0.5; font-size:12px;"></div>
      </div>
      <div class="inline-drawer-content" style="padding-top:8px;">
        <div class="sillyphone-setting-row" style="margin-bottom:12px;">
          <label style="flex:1" title="Use {{prompt}} to inject the visual description">Slash Command</label>
          <input type="text" id="sp_img_cmd" style="flex:2;background:var(--SmartThemeDarkerColor);color:var(--SmartThemeBodyColor);border:1px solid var(--SmartThemeBorderColor);border-radius:4px;padding:4px;" value="${_escHtml(s.imageGenCommand || '/imagine quiet=true "{{prompt}}"')}"/>
        </div>
        <div class="sillyphone-setting-row" style="flex-direction:column; align-items:stretch; gap:4px; margin-bottom:8px;">
          <label title="Instructions given to the AI on how to write the image prompt">AI Instruction</label>
          <textarea id="sp_img_inst" rows="3" style="background:var(--SmartThemeDarkerColor);color:var(--SmartThemeBodyColor);border:1px solid var(--SmartThemeBorderColor);border-radius:4px;padding:6px;resize:vertical;font-family:inherit;">${_escHtml(s.imagePromptInstruction || 'detailed visual description of the photo if applicable, else empty string')}</textarea>
        </div>
        <div class="sillyphone-setting-row" style="flex-direction:column; align-items:stretch; gap:4px;">
          <label title="Profile generation visual guidelines for persistence across posts">Profile Visual Prompt</label>
          <textarea id="sp_prof_vis_inst" rows="3" style="background:var(--SmartThemeDarkerColor);color:var(--SmartThemeBodyColor);border:1px solid var(--SmartThemeBorderColor);border-radius:4px;padding:6px;resize:vertical;font-family:inherit;">${_escHtml(s.profileVisualPrompt || 'Detailed physical description (body type, size, eye color, facial shape, hair style, hair colors, glasses, makeup, clothing style)')}</textarea>
        </div>
      </div>
    </div>
    
    <div class="inline-drawer">
      <div class="inline-drawer-toggle" style="display:flex; justify-content:space-between; align-items:center; padding:6px 4px; margin-top:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.1);">
        <b>👥 Context & NPC</b>
        <div class="inline-drawer-icon fa-solid fa-chevron-down down" style="opacity:0.5; font-size:12px;"></div>
      </div>
      <div class="inline-drawer-content" style="padding-top:8px;">
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label style="flex:1">Context Depth</label>
          <input type="range" id="sp_ctx_depth" min="1" max="100" value="${s.contextDepth || 20}"/>
          <span id="sp_ctx_depth_label">${s.contextDepth || 20}</span>
        </div>
        <div class="sillyphone-setting-row" style="margin-bottom:8px;">
          <label style="flex:1">NPC Contact Chance %</label>
          <input type="range" id="sp_npc_chance" min="0" max="40" value="${s.npcContactChance ?? 8}"/>
          <span id="sp_npc_chance_label">${s.npcContactChance ?? 8}%</span>
        </div>
      </div>
    </div>

  </div>
</div>`;
}

function _bindSettingsPanel() {
    const container = document.querySelector('#extensions_settings');
    if (!container) return;

    // Inject HTML if not already there
    if (!document.getElementById('sillyphone_settings')) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = _buildSettingsHTML();
        container.appendChild(wrapper);
    }

    const s = getSettings();
    document.getElementById('sp_enabled_cb')?.addEventListener('change', e => { s.enabled = e.target.checked; saveSettings(); const fab = document.getElementById('sillyphone-fab'); if (fab) fab.style.display = s.enabled ? 'flex' : 'none'; });
    document.getElementById('sp_card_ctx_cb')?.addEventListener('change', e => { s.includeCardContext = e.target.checked; saveSettings(); });
    document.getElementById('sp_multihog_cb')?.addEventListener('change', e => { s.multihogMode = e.target.checked; saveSettings(); });
    document.getElementById('sp_autoputdown_cb')?.addEventListener('change', e => { s.autoPutDownMessage = e.target.checked; saveSettings(); });
    document.getElementById('sp_putdown_textbox_cb')?.addEventListener('change', e => { s.putDownMessageToTextbox = e.target.checked; saveSettings(); });
    document.getElementById('sp_img_cmd')?.addEventListener('change', e => { s.imageGenCommand = e.target.value; saveSettings(); });
    document.getElementById('sp_img_inst')?.addEventListener('change', e => { s.imagePromptInstruction = e.target.value; saveSettings(); });
    document.getElementById('sp_phone_mode_cb')?.addEventListener('change', e => { s.phoneMode = e.target.checked; saveSettings(); });
    const psSlider = document.getElementById('sp_phone_scale');
    const psLabel = document.getElementById('sp_phone_scale_label');
    psSlider?.addEventListener('input', () => {
        s.phoneScale = parseInt(psSlider.value, 10);
        if (psLabel) psLabel.textContent = `${s.phoneScale}%`;
        saveSettings();
        if (_isOpen && !globalThis._rpgLaptopMode) { _isOpen = false; openPhone(); }
    });
    
    const lsSlider = document.getElementById('sp_laptop_scale');
    const lsLabel = document.getElementById('sp_laptop_scale_label');
    lsSlider?.addEventListener('input', () => {
        s.laptopScale = parseInt(lsSlider.value, 10);
        if (lsLabel) lsLabel.textContent = `${s.laptopScale}%`;
        saveSettings();
        if (_isOpen && globalThis._rpgLaptopMode) { _isOpen = false; openPhone(); }
    });
    document.getElementById('sp_auto_nav_cb')?.addEventListener('change', e => { s.experimentalAutoNavigate = e.target.checked; saveSettings(); });
    document.getElementById('sp_prof_vis_inst')?.addEventListener('change', e => { s.profileVisualPrompt = e.target.value; saveSettings(); });
    const ctxSlider = document.getElementById('sp_ctx_depth');
    const ctxLabel  = document.getElementById('sp_ctx_depth_label');
    ctxSlider?.addEventListener('input', () => { s.contextDepth = parseInt(ctxSlider.value, 10); if (ctxLabel) ctxLabel.textContent = ctxSlider.value; saveSettings(); });
    const npcSlider = document.getElementById('sp_npc_chance');
    const npcLabel  = document.getElementById('sp_npc_chance_label');
    npcSlider?.addEventListener('input', () => { s.npcContactChance = parseInt(npcSlider.value, 10); if (npcLabel) npcLabel.textContent = `${npcSlider.value}%`; saveSettings(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// FAB (Floating Action Button) — draggable phone icon
// ─────────────────────────────────────────────────────────────────────────────

function _buildFAB() {
    if (document.getElementById('sillyphone-fab-container')) return;

    const s = getSettings();
    const container = document.createElement('div');
    container.id = 'sillyphone-fab-container';
    container.style.touchAction = 'none';
    
    // Default position or restored
    if (s.fabX && s.fabY) {
        container.style.left   = s.fabX;
        container.style.top    = s.fabY;
        container.style.bottom = 'auto';
        container.style.right  = 'auto';
    } else if (s.phoneMode) {
        container.style.left = 'calc(50% - 28px)';
        container.style.top = 'calc(50% - 28px)';
    } else {
        container.style.bottom = '20px';
        container.style.right = '20px';
    }

    const fabLaptop = document.createElement('button');
    fabLaptop.className = 'sillyphone-fab-btn';
    fabLaptop.title = 'SillyLaptop';
    fabLaptop.innerHTML = `💻`;
    
    const fabPhone = document.createElement('button');
    fabPhone.className = 'sillyphone-fab-btn';
    fabPhone.title = 'SillyPhone';
    fabPhone.innerHTML = `📱<span id="sillyphone-fab-badge"></span>`;

    if (s.laptopModeEnabled !== false) {
        container.appendChild(fabLaptop);
    }
    container.appendChild(fabPhone);
    document.body.appendChild(container);

    _makeDraggable(container, container, (left, top, wasDragged) => {
        if (wasDragged) {
            const s2 = getSettings();
            s2.fabX = left; s2.fabY = top;
            saveSettings();
        }
    });

    fabPhone.addEventListener('click', (e) => {
        e.stopPropagation();
        globalThis._rpgLaptopMode = false;
        togglePhone();
    });
    
    fabLaptop.addEventListener('click', (e) => {
        e.stopPropagation();
        globalThis._rpgLaptopMode = true;
        togglePhone();
    });

    if (!s.enabled) container.style.display = 'none';
    _updateNotificationBadge();
}

// ─────────────────────────────────────────────────────────────────────────────
// Event hooks
// ─────────────────────────────────────────────────────────────────────────────

async function _tryAutoNavigate() {
    try {
        const ctx = getSTContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        if (!chat.length) return;

        // Grab the last few messages to give context
        const recentMessages = chat.slice(-4).map(m => {
            const raw = String(m.mes || m.content || '').trim();
            return cleanToolCallMessage(raw);
        }).filter(Boolean);
        const combinedNarrative = recentMessages.join('\n\n');
        
        // Quick regex check to avoid unnecessary API calls if no phone words exist in the recent narrative
        const lastMsg = recentMessages[recentMessages.length - 1] || '';
        if (!/(phone|screen|tap|swipe|alert|notification|message|text|call|app|reddit)/i.test(lastMsg)) {
            return;
        }

        const sys = `You are a UI automation agent. Determine if the recent roleplay explicitly describes the player navigating a smartphone interface (e.g. opening an app, checking a message, opening a subreddit).
If they did, return a JSON payload to navigate the UI:
{"navigate": true, "app": "messages"|"reddit", "target": "npc_name" or "subreddit_name"}
If they didn't, return {"navigate": false}
Reply ONLY with valid JSON. CRITICAL: DO NOT wrap the output in markdown code blocks. DO NOT use \`\`\`json or \`\`\`. Write the JSON directly in plain text!`;
        const usr = `Recent narrative:\n${combinedNarrative}\n\nDid the roleplay just show the player navigating their phone? Return JSON.`;

        const raw = await sendPhoneRequest(sys, usr);
        const parsed = _parseJsonRobust(raw, null);
        if (!parsed) return;

        if (parsed.navigate && parsed.app) {
            if (!_isOpen) openPhone();
            if (parsed.app === 'messages') {
                if (parsed.target) _navigateTo('reddit', 'dm_thread', { user: parsed.target });
                else _navigateTo('reddit', 'dm_list');
            } else if (parsed.app === 'reddit') {
                if (parsed.target) _navigateTo('reddit', 'feed', { sub: parsed.target });
                else _navigateTo('reddit', 'home');
            }
        }
    } catch (e) {
        console.warn('[SillyPhone] Auto-navigate failed:', e);
    }
}

function _hookEvents() {
    const ctx = getSTContext();
    if (!ctx.eventSource || !ctx.event_types) {
        // Poll until events are available
        setTimeout(_hookEvents, 1000);
        return;
    }

    const { eventSource, event_types } = ctx;

    // After each AI message → maybe fire NPC contact + update times
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        _npcFiredThisTurn = false;
        _phoneUsedThisTurn = false;
        _updateRelativeTimes();
        _updateStatusBar();
        _updateNotificationBadge();
        maybeFireNpcContact();
        
        const s = getSettings();
        if (s.experimentalAutoNavigate) {
            _tryAutoNavigate();
        }
    });

    // Chat changed → reset per-turn state
    eventSource.on(event_types.CHAT_CHANGED, () => {
        _npcFiredThisTurn = false;
        _phoneUsedThisTurn = false;
        if (_isOpen) { closePhone(); }
        _updateNotificationBadge();
    });

    // Inject [PHONE/COMPUTER_ACTIVITY] into context before generation
    // We use a message sent event to piggyback the context block into the prompt
    // (ST doesn't have a direct pre-generation hook in extensions, so we inject
    //  via the extensionPrompt API if available, or via a chat message formatter)
    if (ctx.setExtensionPrompt) {
        // Poll and update every message sent
        eventSource.on(event_types.MESSAGE_SENT, () => {
            const block = buildPhoneContextBlock();
            if (block) {
                ctx.setExtensionPrompt(ST_EXT_NAME, block, /* position */ 1, /* depth */ 4);
            } else {
                ctx.setExtensionPrompt(ST_EXT_NAME, '', 1, 4);
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

(function init() {
    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
        return;
    }

    console.log('[SillyPhone] Loading…');

    _buildFAB();
    _bindSettingsPanel();
    _hookEvents();

    console.log('[SillyPhone] Ready ✓');
})();
