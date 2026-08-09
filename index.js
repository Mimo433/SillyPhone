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
        const cleanSummary = _summarizeText(summary, 280);
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

        return `[PHONE_ACTIVITY]\n${lines.join('\n')}${unreadNote}\n[/PHONE_ACTIVITY]`;
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

        const systemPrompt = `You decide if an NPC should contact the player via phone right now. Be realistic and conservative — only say yes when it genuinely fits the current situation. Reply ONLY with valid JSON.`;
        const userPrompt = `${cardBlockStr}NPC: ${chosen}
Recent story events:
${combinedNarrative.slice(-1500)}

Would ${chosen} realistically reach out to the player right now via phone?
Consider: their relationship, what just happened, urgency, time of day.
Reply ONLY with: {"contact": true, "type": "text"|"call"|"missed_call", "message": "<what they say or null for missed_call>"} or {"contact": false}`;

        let raw;
        try { raw = await sendPhoneRequest(systemPrompt, userPrompt); } catch { return; }

        let parsed;
        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return;
            parsed = JSON.parse(jsonMatch[0]);
        } catch { return; }

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

function openPhone() {
    if (!_phoneEl) _buildPhonePanel();
    _isOpen = true;
    _phoneEl.style.display = 'flex';
    _applyGenreSkin();
    _restorePanelPosition();
    _updateStatusBar();
    _navigateHome();
}

function closePhone() {
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
const DRAG_THRESHOLD = 6; // pixels
function _makeDraggable(el, handleEl, onDragEnd) {
    let x0 = 0, y0 = 0, startL = 0, startT = 0, moved = false;

    handleEl.addEventListener('mousedown', startDrag);
    handleEl.addEventListener('touchstart', e => startDrag(e.touches[0]), { passive: true });

    function startDrag(e) {
        x0 = e.clientX; y0 = e.clientY;
        moved = false;
        const rect = el.getBoundingClientRect();
        startL = rect.left; startT = rect.top;

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        document.addEventListener('touchmove',  onTouchMove, { passive: false });
        document.addEventListener('touchend',   onUp);
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
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('touchmove',  onTouchMove);
        document.removeEventListener('touchend',   onUp);
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
    _phoneEl.innerHTML = _phoneShellHTML();

    document.body.appendChild(_phoneEl);

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
    return `
<div class="rpg-phone-shell">
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
    if (s.panelX && s.panelY && _phoneEl) {
        _phoneEl.style.transform = 'none';
        _phoneEl.style.left = s.panelX;
        _phoneEl.style.top  = s.panelY;
    } else if (_phoneEl) {
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
        { id: 'google',    icon: '🔍', label: 'Google'    },
        { id: 'reddit',    icon: '🤖', label: 'Reddit'    },
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
    const iconsHTML = allApps.map(app => `
<div class="rpg-phone-app-icon" data-app="${app.id}" role="button" tabindex="0" aria-label="${app.label}">
  <div class="rpg-phone-app-icon-img">${app.icon}${app.badge || ''}</div>
  <div class="rpg-phone-app-icon-label">${app.label}</div>
</div>`).join('');
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
    return text.replace(/\[IMAGE:\s*(.*?)\]/gi, (match, desc) => {
        const cleanDesc = desc.trim();
        return `<div class="rpg-phone-image-placeholder" data-img-prompt="${_escHtml(cleanDesc)}" role="button" tabindex="0">
            <span>🖼️ Click to generate image</span>
        </div>`;
    });
}

function _bindPhoneImages(screen) {
    if (!screen) return;
    screen.querySelectorAll('.rpg-phone-image-placeholder').forEach(el => {
        if (el._hasImgListener) return;
        el._hasImgListener = true;
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (el.dataset.generating === 'true') return;
            const desc = el.dataset.imgPrompt;
            if (!desc) return;
            el.dataset.generating = 'true';
            el.innerHTML = '<span>⏳ Generating image…</span>';
            try {
                const ctx = getSTContext();
                // Try ST's built-in /imagine slash command
                if (ctx.executeSlashCommandsWithOptions) {
                    const escapedPrompt = desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const result = await ctx.executeSlashCommandsWithOptions(`/imagine quiet=true "${escapedPrompt}"`);
                    if (result?.pipe) {
                        el.innerHTML = `<img src="${_escHtml(result.pipe)}" style="width:100%;border-radius:8px;cursor:pointer;display:block;" onclick="window.open(this.src,'_blank')" />`;
                        el.style.cssText = 'border:none;padding:0;background:transparent;';
                        el.dataset.generating = 'done';
                        return;
                    }
                }
                el.dataset.generating = '';
                el.innerHTML = '<span style="color:#ff6b6b">Image generation not available. Use /imagine in chat.</span>';
            } catch (err) {
                el.dataset.generating = '';
                el.innerHTML = `<span style="color:#ff6b6b">❌ ${_escHtml(err.message || String(err))}</span>`;
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Page router
// ─────────────────────────────────────────────────────────────────────────────

function _renderPage(appId, pageId, params) {
    const screen = _getScreen();
    if (!screen) return;
    _setRefreshAction(null);
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
        const sys = `You simulate Google search results in this fictional narrative world. Reply ONLY with valid JSON array — no markdown, no explanation.`;
        const usr = `${sceneCtx}\n\nGenerate 5 realistic Google search results for the query: "${query}"\nJSON: [{"url":"","title":"","snippet":""}]`;
        try {
            const raw = await sendPhoneRequest(sys, usr);
            const match = raw.match(/\[[\s\S]*\]/);
            const results = match ? JSON.parse(match[0]) : [];
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

    if (pageId === 'home' || !pageId) {
        _logPhoneActivity('reddit', 'Reddit', 'out', 'Opened Reddit');
        const cacheKey = 'reddit_subs';
        if (ps.phoneCache[cacheKey]) { _renderRedditSubList(screen, ps.phoneCache[cacheKey]); return; }
        const sceneCtx = _buildSceneContext(1000);
        const sys = `You generate a list of reddit-like communities fitting this story world. Reply ONLY valid JSON array.`;
        const usr = `${sceneCtx}\n\nGenerate 6 relevant subreddits for this world. Format: [{"name":"r/name","icon":"emoji","description":"short desc"}]`;
        try {
            const raw  = await sendPhoneRequest(sys, usr);
            const match = raw.match(/\[[\s\S]*\]/);
            const subs  = match ? JSON.parse(match[0]) : [];
            ps.phoneCache[cacheKey] = subs; savePhoneState();
            _renderRedditSubList(screen, subs);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('home', params, screen); });
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Reddit unavailable: ${_escHtml(e.message)}</div>`; }
        return;
    }

    if (pageId === 'sub') {
        const sub = params.sub || 'r/all';
        _setNavTitle(sub);
        _logPhoneActivity('reddit', sub, 'out', `Browsing ${sub}`);
        const cacheKey = `reddit_feed_${sub}`;
        if (ps.phoneCache[cacheKey]) { _renderRedditFeed(screen, sub, ps.phoneCache[cacheKey]); return; }
        const sceneCtx = _buildSceneContext(1000);
        const sys = `You generate realistic Reddit posts for the community ${sub} in this story world. Reply ONLY valid JSON array.`;
        const usr = `${sceneCtx}\n\nGenerate 6 Reddit posts for ${sub}. Format: [{"title":"","flair":"","author":"u/name","upvotes":0,"comments":0,"preview":"short preview text"}]`;
        try {
            const raw   = await sendPhoneRequest(sys, usr);
            const match  = raw.match(/\[[\s\S]*\]/);
            const posts  = match ? JSON.parse(match[0]) : [];
            ps.phoneCache[cacheKey] = posts; savePhoneState();
            _renderRedditFeed(screen, sub, posts);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('sub', params, screen); });
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Feed failed: ${_escHtml(e.message)}</div>`; }
        return;
    }

    if (pageId === 'post') {
        const post = params.post || {};
        _setNavTitle(post.title ? post.title.slice(0, 30) + '…' : 'Post');
        _logPhoneActivity('reddit', params.sub || 'Reddit', 'in', `Read post: "${_summarizeText(post.title, 60)}"`);

        const cacheKey = `reddit_post_${params.sub}_${encodeURIComponent(post.title || '')}`;
        if (ps.phoneCache[cacheKey]) { _renderRedditPost(screen, post, params.sub, ps.phoneCache[cacheKey]); return; }

        const sceneCtx = _buildSceneContext(1000);
        const sys = `You write the body text and comments for a Reddit post in this story world. Reply ONLY valid JSON.`;
        const usr = `${sceneCtx}\n\nWrite the body and top comments for this Reddit post in ${params.sub}:\nTitle: "${post.title}"\nFlair: ${post.flair || ''}\nPreview: ${post.preview || ''}\n\nReply ONLY with: {"body":"full post body text","comments":[{"author":"u/name","upvotes":0,"text":"comment text","replies":[{"author":"u/name","upvotes":0,"text":"reply"}]}]}`;
        try {
            const raw   = await sendPhoneRequest(sys, usr);
            const match  = raw.match(/\{[\s\S]*\}/);
            const data   = match ? JSON.parse(match[0]) : { body: '', comments: [] };
            ps.phoneCache[cacheKey] = data; savePhoneState();
            _renderRedditPost(screen, post, params.sub, data);
            _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; savePhoneState(); _renderRedditApp('post', params, screen); });
        } catch (e) { screen.innerHTML = `<div class="rpg-phone-error">Post failed: ${_escHtml(e.message)}</div>`; }
    }
}

function _renderRedditSubList(screen, subs) {
    const html = subs.map(s => `
<div class="rpg-phone-reddit-sub" data-sub="${_escHtml(s.name)}">
  <div class="rpg-phone-reddit-sub-icon">${s.icon || '🤖'}</div>
  <div>
    <div class="rpg-phone-reddit-sub-name">${_escHtml(s.name)}</div>
    <div class="rpg-phone-reddit-sub-desc">${_escHtml(s.description || '')}</div>
  </div>
</div>`).join('');
    screen.innerHTML = `<div class="rpg-phone-reddit-header"><span class="rpg-phone-reddit-logo">reddit</span><span>Communities</span></div>${html}`;
    screen.querySelectorAll('.rpg-phone-reddit-sub').forEach(el => {
        el.addEventListener('click', () => _navigateTo('reddit', 'sub', { sub: el.dataset.sub }));
    });
}

function _renderRedditFeed(screen, sub, posts) {
    const postsHTML = posts.map((p, i) => `
<div class="rpg-phone-reddit-post" data-idx="${i}">
  ${p.flair ? `<span class="rpg-phone-reddit-flair">${_escHtml(p.flair)}</span>` : ''}
  <div class="rpg-phone-reddit-post-title">${_escHtml(p.title || '')}</div>
  <div class="rpg-phone-reddit-post-meta">
    <span>⬆ ${p.upvotes || 0}</span>
    <span>💬 ${p.comments || 0}</span>
    <span>${_escHtml(p.author || '')}</span>
  </div>
  ${p.preview ? `<div class="rpg-phone-reddit-post-preview">${_escHtml(p.preview)}</div>` : ''}
</div>`).join('');
    screen.innerHTML = `<div class="rpg-phone-reddit-sub-header">${_escHtml(sub)}</div>${postsHTML}`;
    screen.querySelectorAll('.rpg-phone-reddit-post').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            _logPhoneActivity('reddit', sub, 'in', `Opened post: "${_summarizeText(posts[idx]?.title, 60)}"`);
            _navigateTo('reddit', 'post', { sub, post: posts[idx] });
        });
    });
}

function _renderRedditPost(screen, post, sub, data) {
    const ps = getPhoneState();
    const voteKey = `${sub}_${encodeURIComponent(post.title || '')}`;
    const vote = ps.phoneVotes[voteKey] || 0;

    const commentsHTML = (data.comments || []).map(c => {
        const repliesHTML = (c.replies || []).map(r => `
<div class="rpg-phone-reddit-reply">
  <span class="rpg-phone-reddit-comment-author">${_escHtml(r.author || '')}</span>
  <span class="rpg-phone-reddit-comment-up">⬆ ${r.upvotes || 0}</span>
  <div class="rpg-phone-reddit-comment-text">${_escHtml(r.text || '')}</div>
</div>`).join('');
        return `
<div class="rpg-phone-reddit-comment">
  <span class="rpg-phone-reddit-comment-author">${_escHtml(c.author || '')}</span>
  <span class="rpg-phone-reddit-comment-up">⬆ ${c.upvotes || 0}</span>
  <div class="rpg-phone-reddit-comment-text">${_escHtml(c.text || '')}</div>
  ${repliesHTML}
</div>`;
    }).join('');

    screen.innerHTML = `
<div class="rpg-phone-reddit-post-detail">
  ${post.flair ? `<span class="rpg-phone-reddit-flair">${_escHtml(post.flair)}</span>` : ''}
  <div class="rpg-phone-reddit-post-detail-title">${_escHtml(post.title || '')}</div>
  <div class="rpg-phone-reddit-post-body">${_escHtml(data.body || '')}</div>
  <div class="rpg-phone-reddit-post-actions">
    <button class="rpg-phone-vote-btn ${vote > 0 ? 'voted-up' : ''}" id="rph_vote_up">⬆</button>
    <span class="rpg-phone-vote-score ${vote > 0 ? 'vote-up' : vote < 0 ? 'vote-down' : ''}" id="rph_vote_score">${(post.upvotes || 0) + vote}</span>
    <button class="rpg-phone-vote-btn ${vote < 0 ? 'voted-down' : ''}" id="rph_vote_dn">⬇</button>
    <span style="margin-left:8px">💬 ${post.comments || 0}</span>
  </div>
  <div class="rpg-phone-reddit-comments-section">
    <h4>Comments</h4>
    ${commentsHTML || '<p class="rpg-phone-muted" style="padding:8px 0">No comments yet.</p>'}
  </div>
</div>`;

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
  <span class="rpg-phone-appstore-app-icon">${a.icon || '📱'}</span>
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
            const sys = `You design a JSON blueprint for a fictional smartphone app that fits this story world. Reply ONLY valid JSON.`;
            const usr = `${sceneCtx}\n\nDesign the app: "${name}" — ${desc}\nBlueprint format: {"id":"slug","name":"","icon":"","description":"","tagline":"","categories":["cat1","cat2"],"feedLabel":"Latest","feedItems":[{"title":"","subtitle":"","badge":"","description":"","stats":{"stat1":"val"},"actions":[{"label":"Action","prompt":"<instruction for AI>"}],"reviews":[{"user":"","text":""}]}]}`;
            try {
                const raw   = await sendPhoneRequest(sys, usr);
                const match  = raw.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('No JSON found');
                const bp = JSON.parse(match[0]);
                if (!bp.id) bp.id = name.toLowerCase().replace(/\W+/g, '_') + '_' + Date.now();
                if (!bp.name) bp.name = name;
                if (!bp.icon) bp.icon = icon;

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
        const sys = `You generate fresh content for the app "${app.name}" (${app.description || ''}) in this story world. Reply ONLY valid JSON array matching the app blueprint.`;
        const usr = `${sceneCtx}\n\nGenerate 5 content cards for ${app.name}. Use same structure as the blueprint feedItems: [{"title":"","subtitle":"","badge":"","description":"","stats":{},"actions":[{"label":"","prompt":""}],"reviews":[]}]`;
        try {
            const raw   = await sendPhoneRequest(sys, usr);
            const match  = raw.match(/\[[\s\S]*\]/);
            const items  = match ? JSON.parse(match[0]) : app.feedItems || [];
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
      <span class="rpg-phone-app-header-icon">${app.icon || '📱'}</span>
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
                const escaped = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const result  = await ctx.executeSlashCommandsWithOptions(`/imagine quiet=true "${escaped}"`);
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
    const s = getSettings();

    screen.innerHTML = `
<div class="rpg-phone-settings-app">
  <h3>SillyPhone Settings</h3>
  <label class="rpg-phone-settings-row">
    <span>Include active card & world context in AI prompts</span>
    <input type="checkbox" id="rpg_phone_card_ctx_toggle" ${s.includeCardContext !== false ? 'checked' : ''}/>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Multihog Mode (Read PC data from Multihog framework)</span>
    <input type="checkbox" id="rpg_phone_multihog_toggle" ${s.multihogMode ? 'checked' : ''}/>
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

    document.getElementById('rpg_phone_card_ctx_toggle')?.addEventListener('change', e => { s.includeCardContext = e.target.checked; saveSettings(); });
    document.getElementById('rpg_phone_multihog_toggle')?.addEventListener('change', e => { s.multihogMode = e.target.checked; saveSettings(); });
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
<div id="sillyphone_settings">
  <h4>SillyPhone</h4>
  <div class="sillyphone-setting-row">
    <label><input type="checkbox" id="sp_enabled_cb" ${s.enabled ? 'checked' : ''}/> Enable SillyPhone</label>
  </div>
  <div class="sillyphone-setting-row">
    <label><input type="checkbox" id="sp_card_ctx_cb" ${s.includeCardContext !== false ? 'checked' : ''}/> Include Active Card Context in AI prompts</label>
  </div>
  <div class="sillyphone-setting-row">
    <label><input type="checkbox" id="sp_multihog_cb" ${s.multihogMode ? 'checked' : ''}/> Enable Multihog Mode (Read Multihog PC data)</label>
  </div>
  <h4>Context & NPC</h4>
  <div class="sillyphone-setting-row">
    <label style="flex:1">Context Depth</label>
    <input type="range" id="sp_ctx_depth" min="1" max="100" value="${s.contextDepth || 20}"/>
    <span id="sp_ctx_depth_label">${s.contextDepth || 20}</span>
  </div>
  <div class="sillyphone-setting-row">
    <label style="flex:1">NPC Contact Chance %</label>
    <input type="range" id="sp_npc_chance" min="0" max="40" value="${s.npcContactChance ?? 8}"/>
    <span id="sp_npc_chance_label">${s.npcContactChance ?? 8}%</span>
  </div>
  <h4>Data</h4>
  <div class="sillyphone-setting-row">
    <button class="rpg-phone-btn rpg-phone-btn-secondary" id="sp_open_btn" style="width:auto;padding:6px 16px;">📱 Open Phone</button>
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
    const ctxSlider = document.getElementById('sp_ctx_depth');
    const ctxLabel  = document.getElementById('sp_ctx_depth_label');
    ctxSlider?.addEventListener('input', () => { s.contextDepth = parseInt(ctxSlider.value, 10); if (ctxLabel) ctxLabel.textContent = ctxSlider.value; saveSettings(); });
    const npcSlider = document.getElementById('sp_npc_chance');
    const npcLabel  = document.getElementById('sp_npc_chance_label');
    npcSlider?.addEventListener('input', () => { s.npcContactChance = parseInt(npcSlider.value, 10); if (npcLabel) npcLabel.textContent = `${npcSlider.value}%`; saveSettings(); });
    document.getElementById('sp_open_btn')?.addEventListener('click', togglePhone);
}

// ─────────────────────────────────────────────────────────────────────────────
// FAB (Floating Action Button) — draggable phone icon
// ─────────────────────────────────────────────────────────────────────────────

function _buildFAB() {
    if (document.getElementById('sillyphone-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'sillyphone-fab';
    fab.title = 'SillyPhone';
    fab.innerHTML = `📱<span id="sillyphone-fab-badge"></span>`;
    document.body.appendChild(fab);

    // Restore saved position
    const s = getSettings();
    if (s.fabX && s.fabY) {
        fab.style.position = 'fixed';
        fab.style.left   = s.fabX;
        fab.style.top    = s.fabY;
        fab.style.bottom = 'auto';
        fab.style.right  = 'auto';
    }

    // Toggle on click — _makeDraggable tells us if it was a real drag via the 3rd arg
    _makeDraggable(fab, fab, (left, top, wasDragged) => {
        if (wasDragged) {
            // Only save position on a real drag
            const s2 = getSettings();
            s2.fabX = left; s2.fabY = top;
            saveSettings();
        } else {
            // It was a click — open/close the phone
            togglePhone();
        }
    });

    if (!s.enabled) fab.style.display = 'none';
    _updateNotificationBadge();
}

// ─────────────────────────────────────────────────────────────────────────────
// Event hooks
// ─────────────────────────────────────────────────────────────────────────────

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
    });

    // Chat changed → reset per-turn state
    eventSource.on(event_types.CHAT_CHANGED, () => {
        _npcFiredThisTurn = false;
        _phoneUsedThisTurn = false;
        if (_isOpen) { closePhone(); }
        _updateNotificationBadge();
    });

    // Inject [PHONE_ACTIVITY] into context before generation
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
