// ==========================================================
//  AI Interactive Character Web App — Main Script
//  Frame-by-Frame Animation + AI Chat Engine
// ==========================================================

// ===================== CONFIGURATION =====================
const API_KEY = "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";
const PROVIDER = "groq";  // "groq" or "google"
const IDLE_TIMEOUT = 80000; // 80 seconds

// ===================== CONSTANTS =========================
const FRAME_RATE = 24;
const FRAME_INTERVAL = 1000 / FRAME_RATE;
const MAX_CACHED_FOLDERS = 4;
const EMOTION_RETURN_DELAY = 5000; // ms before emotion returns to natural

// Folder name mapping (logical → actual folder name on disk)
const FOLDER_MAP = {
    natural: 'natural',
    blink: 'blink',
    thinking: 'thinking',
    talking: 'talking',
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    confused: 'confused',
    suprised: 'suprised',   // typo on disk, kept as-is
    listening: 'listening'
};

// Frame counts per folder
const FRAME_COUNTS = {
    natural: 240,
    blink: 240,
    thinking: 240,
    talking: 240,
    happy: 240,
    sad: 240,
    angry: 210,
    confused: 240,
    suprised: 240,
    listening: 240
};

// State categories
const ONE_SHOT_STATES = new Set(['blink', 'suprised']);
const EMOTION_STATES = new Set(['happy', 'sad', 'angry', 'confused']);
const CONTINUOUS_STATES = new Set(['natural', 'talking', 'thinking', 'listening']);

// AI Provider endpoints
const API_ENDPOINTS = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    google: '' // built dynamically with API key
};
const AI_MODELS = {
    groq: 'llama-3.3-70b-versatile',
    google: 'gemini-2.0-flash'
};

// System prompt for AI
const SYSTEM_PROMPT = `Kamu adalah karakter AI anime yang interaktif, lucu, dan ekspresif. Kamu berbicara dalam bahasa Indonesia santai dan gaul.

ATURAN PENTING:
1. Setiap respons HARUS diawali dengan SATU tag emosi dalam format [EMOSI].
2. Tag emosi yang tersedia: [HAPPY], [SAD], [ANGRY], [CONFUSED], [SURPRISED], [NEUTRAL]
3. Pilih tag yang paling sesuai dengan emosi responsmu.
4. Setelah tag emosi, tulis responsmu secara natural tanpa menyebutkan tag lagi.
5. Jawab dengan singkat dan ekspresif (1-3 kalimat).
6. Gunakan emoji sesekali untuk menambah ekspresi.

Contoh format respons:
[HAPPY] Wah senangnya bisa ngobrol sama kamu! 😄
[CONFUSED] Hmm, aku agak bingung nih... Bisa jelasin lagi?
[NEUTRAL] Oke oke, aku dengerin kok. Terus gimana?`;

const IDLE_PROMPTS = [
    "User sudah diam selama lebih dari 1 menit. Tanyakan dengan lucu kenapa mereka diam.",
    "User sepertinya AFK. Berikan reaksi bingung atau kangen.",
    "User tidak merespons. Coba ajak bicara lagi dengan cara yang lucu.",
    "Kamu merasa kesepian karena user diam lama. Ungkapkan perasaanmu."
];

// ===================== STATE =============================
let currentState = 'natural';
let currentFrame = 1;
let frameCache = new Map();     // folder → Image[]
let cacheLRU = [];              // folder names in LRU order
let isPreloading = false;
let animationId = null;
let lastFrameTime = 0;
let activeImgSlot = 'a';       // double-buffer: 'a' or 'b'

let chatHistory = [];
let isAIResponding = false;
let idleTimer = null;
let emotionTimer = null;
let isUserTyping = false;
let previousStateBeforeListening = 'natural';

// ===================== DOM REFS ==========================
const charFrameA = document.getElementById('char-frame-a');
const charFrameB = document.getElementById('char-frame-b');
const stateBadge = document.getElementById('state-badge');
const preloadBarContainer = document.getElementById('preload-bar-container');
const preloadBar = document.getElementById('preload-bar');
const preloadPercent = document.getElementById('preload-percent');

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const btnClear = document.getElementById('btn-clear');
const typingIndicator = document.getElementById('typing-indicator');
const aiStatusText = document.getElementById('ai-status-text');


// ==========================================================
//  IMAGE PRELOADER
// ==========================================================

function getFramePath(folder, frameNum) {
    const folderName = FOLDER_MAP[folder];
    const padded = String(frameNum).padStart(3, '0');
    return `images/${folderName}/ezgif-frame-${padded}.jpg`;
}

async function preloadFolder(folder) {
    if (frameCache.has(folder)) {
        // Move to end of LRU
        cacheLRU = cacheLRU.filter(f => f !== folder);
        cacheLRU.push(folder);
        return;
    }

    const totalFrames = FRAME_COUNTS[folder];
    const images = new Array(totalFrames);
    let loaded = 0;

    // Show progress bar
    preloadBarContainer.style.opacity = '1';

    const promises = [];
    for (let i = 1; i <= totalFrames; i++) {
        promises.push(new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                loaded++;
                const pct = Math.round((loaded / totalFrames) * 100);
                preloadBar.style.width = pct + '%';
                preloadPercent.textContent = pct + '%';
                resolve();
            };
            img.onerror = () => {
                loaded++;
                resolve();
            };
            img.src = getFramePath(folder, i);
            images[i - 1] = img;
        }));
    }

    await Promise.all(promises);

    // Store in cache
    frameCache.set(folder, images);
    cacheLRU.push(folder);

    // Evict oldest if over limit (but never evict 'natural')
    while (cacheLRU.length > MAX_CACHED_FOLDERS) {
        const oldest = cacheLRU.find(f => f !== 'natural' && f !== currentState);
        if (oldest) {
            frameCache.delete(oldest);
            cacheLRU = cacheLRU.filter(f => f !== oldest);
        } else {
            break;
        }
    }

    // Hide progress bar
    setTimeout(() => {
        preloadBarContainer.style.opacity = '0';
    }, 500);
}


// ==========================================================
//  ANIMATION ENGINE
// ==========================================================

function getActiveImg() {
    return activeImgSlot === 'a' ? charFrameA : charFrameB;
}
function getInactiveImg() {
    return activeImgSlot === 'a' ? charFrameB : charFrameA;
}

function swapBuffers() {
    const active = getActiveImg();
    const inactive = getInactiveImg();
    inactive.style.opacity = '1';
    active.style.opacity = '0';
    activeImgSlot = activeImgSlot === 'a' ? 'b' : 'a';
}

function displayFrame(folder, frameIndex) {
    const images = frameCache.get(folder);
    if (!images || !images[frameIndex]) return;

    const img = images[frameIndex];
    const inactive = getInactiveImg();

    if (img.complete && img.naturalWidth > 0) {
        inactive.src = img.src;
        swapBuffers();
    } else {
        // Fallback: set src and wait
        inactive.onload = () => {
            swapBuffers();
            inactive.onload = null;
        };
        inactive.src = img.src;
    }
}

function animationLoop(timestamp) {
    animationId = requestAnimationFrame(animationLoop);

    if (timestamp - lastFrameTime < FRAME_INTERVAL) return;
    lastFrameTime = timestamp;

    const totalFrames = FRAME_COUNTS[currentState];
    if (!frameCache.has(currentState)) return;

    displayFrame(currentState, currentFrame - 1);

    currentFrame++;

    // Handle loop/transition
    if (currentFrame > totalFrames) {
        if (ONE_SHOT_STATES.has(currentState)) {
            // One-shot: return to natural
            switchState('natural');
        } else {
            // Loop: reset to frame 1
            currentFrame = 1;
        }
    }
}

function startAnimation() {
    if (animationId) cancelAnimationFrame(animationId);
    lastFrameTime = 0;
    animationId = requestAnimationFrame(animationLoop);
}

function stopAnimation() {
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
}


// ==========================================================
//  STATE MACHINE
// ==========================================================

async function switchState(newState) {
    if (newState === currentState && currentFrame !== 1) return;
    if (!FOLDER_MAP[newState]) {
        console.warn(`Unknown state: ${newState}`);
        return;
    }

    // Clear emotion timer
    if (emotionTimer) {
        clearTimeout(emotionTimer);
        emotionTimer = null;
    }

    // Preload if needed
    if (!frameCache.has(newState)) {
        await preloadFolder(newState);
    }

    currentState = newState;
    currentFrame = 1;

    // Update badge
    stateBadge.textContent = newState;

    // Set emotion return timer for emotion states
    if (EMOTION_STATES.has(newState) && !isAIResponding) {
        emotionTimer = setTimeout(() => {
            if (currentState === newState) {
                switchState('natural');
            }
        }, EMOTION_RETURN_DELAY);
    }
}

function mapEmotionTag(tag) {
    const map = {
        'HAPPY': 'happy',
        'SAD': 'sad',
        'ANGRY': 'angry',
        'CONFUSED': 'confused',
        'SURPRISED': 'suprised',
        'NEUTRAL': 'natural'
    };
    return map[tag.toUpperCase()] || 'natural';
}


// ==========================================================
//  CHAT UI
// ==========================================================

function addMessage(text, sender = 'user') {
    const wrapper = document.createElement('div');
    wrapper.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'}`;

    const bubble = document.createElement('div');
    bubble.className = sender === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai';

    const p = document.createElement('p');
    p.className = 'text-sm leading-relaxed';
    p.textContent = text;

    bubble.appendChild(p);
    wrapper.appendChild(bubble);

    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.justify-center');
    if (welcome && sender === 'user') welcome.remove();

    chatMessages.appendChild(wrapper);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return p; // Return for streaming updates
}

function showTypingIndicator(show) {
    typingIndicator.classList.toggle('hidden', !show);
    if (show) {
        aiStatusText.textContent = 'Mengetik...';
        aiStatusText.className = 'text-xs text-accent-400/80 font-medium';
    } else {
        aiStatusText.textContent = 'Online';
        aiStatusText.className = 'text-xs text-emerald-400/80 font-medium';
    }
}

function clearChat() {
    chatMessages.innerHTML = `
        <div class="flex justify-center">
            <div class="px-4 py-2 rounded-full bg-white/5 text-xs text-white/30 font-medium">
                Mulai percakapan dengan AI Character ✨
            </div>
        </div>`;
    chatHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
}

// Auto-resize textarea
chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 112) + 'px';

    // Enable/disable send button
    btnSend.disabled = !chatInput.value.trim();
});


// ==========================================================
//  AI INTEGRATION
// ==========================================================

async function sendToAI(userMessage) {
    if (isAIResponding) return;
    isAIResponding = true;

    // Add to history
    chatHistory.push({ role: 'user', content: userMessage });

    // Show thinking state
    await switchState('thinking');
    showTypingIndicator(true);

    try {
        let aiText = '';

        if (PROVIDER === 'groq') {
            aiText = await callGroqAPI();
        } else if (PROVIDER === 'google') {
            aiText = await callGoogleAPI();
        }

        // Parse emotion tag
        const { emotion, cleanText } = parseEmotionTag(aiText);

        // Switch to talking briefly, then to emotion
        await switchState('talking');

        // Add AI message
        showTypingIndicator(false);
        addMessage(cleanText, 'ai');

        // Add to history
        chatHistory.push({ role: 'assistant', content: aiText });

        // After a brief talking animation, switch to detected emotion
        setTimeout(() => {
            switchState(emotion);
        }, 800);

    } catch (error) {
        console.error('AI Error:', error);
        showTypingIndicator(false);
        addMessage(`⚠️ Error: ${error.message}`, 'ai');
        await switchState('confused');
    } finally {
        isAIResponding = false;
        resetIdleTimer();
    }
}

async function callGroqAPI() {
    const response = await fetch(API_ENDPOINTS.groq, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: AI_MODELS.groq,
            messages: chatHistory,
            temperature: 0.8,
            max_tokens: 300,
            top_p: 0.9
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `Groq API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '[NEUTRAL] Maaf, aku tidak bisa merespons.';
}

async function callGoogleAPI() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODELS.google}:generateContent?key=${API_KEY}`;

    // Convert chat history to Google's format
    const contents = [];
    for (const msg of chatHistory) {
        if (msg.role === 'system') continue; // Google handles system prompt differently
        contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contents,
            systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
            },
            generationConfig: {
                temperature: 0.8,
                maxOutputTokens: 300,
                topP: 0.9
            }
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `Google API error: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '[NEUTRAL] Maaf, aku tidak bisa merespons.';
}


// ==========================================================
//  EMOTION TAG PARSER
// ==========================================================

function parseEmotionTag(text) {
    const tagMatch = text.match(/^\[([A-Z]+)\]\s*/);
    if (tagMatch) {
        const emotion = mapEmotionTag(tagMatch[1]);
        const cleanText = text.replace(tagMatch[0], '').trim();
        return { emotion, cleanText };
    }
    return { emotion: 'natural', cleanText: text.trim() };
}


// ==========================================================
//  IDLE TIMER
// ==========================================================

function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(handleIdle, IDLE_TIMEOUT);
}

async function handleIdle() {
    if (isAIResponding) {
        resetIdleTimer();
        return;
    }

    const prompt = IDLE_PROMPTS[Math.floor(Math.random() * IDLE_PROMPTS.length)];
    chatHistory.push({ role: 'user', content: prompt });

    // Don't show idle prompt in UI, just send to AI
    await sendToAIInternal();
}

async function sendToAIInternal() {
    if (isAIResponding) return;
    isAIResponding = true;

    await switchState('confused');
    showTypingIndicator(true);

    try {
        let aiText = '';
        if (PROVIDER === 'groq') {
            aiText = await callGroqAPI();
        } else {
            aiText = await callGoogleAPI();
        }

        const { emotion, cleanText } = parseEmotionTag(aiText);

        showTypingIndicator(false);
        addMessage(cleanText, 'ai');
        chatHistory.push({ role: 'assistant', content: aiText });

        setTimeout(() => switchState(emotion), 500);

    } catch (error) {
        console.error('Idle AI Error:', error);
        showTypingIndicator(false);
        addMessage('💤 ...', 'ai');
        await switchState('natural');
    } finally {
        isAIResponding = false;
        resetIdleTimer();
    }
}


// ==========================================================
//  USER INTERACTION HANDLERS
// ==========================================================

// --- Send message ---
async function handleSend() {
    const text = chatInput.value.trim();
    if (!text || isAIResponding) return;

    // Reset UI
    chatInput.value = '';
    chatInput.style.height = 'auto';
    btnSend.disabled = true;
    isUserTyping = false;

    // Add user message
    addMessage(text, 'user');

    // Reset idle timer
    resetIdleTimer();

    // Send to AI
    await sendToAI(text);
}

btnSend.addEventListener('click', handleSend);

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
    }
});

// --- Typing detection → listening state ---
let typingDebounce = null;

chatInput.addEventListener('input', () => {
    resetIdleTimer();

    if (!isUserTyping && !isAIResponding) {
        isUserTyping = true;
        previousStateBeforeListening = currentState;
        switchState('listening');
    }

    // Reset typing debounce
    if (typingDebounce) clearTimeout(typingDebounce);
    typingDebounce = setTimeout(() => {
        if (isUserTyping && !isAIResponding) {
            isUserTyping = false;
            switchState(previousStateBeforeListening === 'listening' ? 'natural' : previousStateBeforeListening);
        }
    }, 2000);
});

chatInput.addEventListener('focus', () => {
    resetIdleTimer();
});

// --- Clear chat ---
btnClear.addEventListener('click', () => {
    clearChat();
    resetIdleTimer();
    switchState('natural');
});

// --- Global activity tracking for idle reset ---
document.addEventListener('mousemove', resetIdleTimer);
document.addEventListener('click', resetIdleTimer);
document.addEventListener('touchstart', resetIdleTimer);


// ==========================================================
//  INITIALIZATION
// ==========================================================

async function init() {
    // Initialize chat history
    chatHistory = [{ role: 'system', content: SYSTEM_PROMPT }];

    // Preload natural state first (required)
    await preloadFolder('natural');

    // Start animation
    startAnimation();
    await switchState('natural');

    // Start idle timer
    resetIdleTimer();

    // Background preload common states
    setTimeout(async () => {
        await preloadFolder('listening');
        await preloadFolder('thinking');
        await preloadFolder('talking');
    }, 2000);

    console.log('✅ AI Character App initialized');
    console.log(`   Provider: ${PROVIDER}`);
    console.log(`   Idle timeout: ${IDLE_TIMEOUT}ms`);
    console.log(`   API Key: ${API_KEY === 'ISI_DI_SINI' ? '⚠️ NOT SET' : '✓ Set'}`);
}

// Boot
init();
