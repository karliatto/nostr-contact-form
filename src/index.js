import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey, finalizeEvent, validateEvent, getEventHash } from 'nostr-tools';
import { encrypt } from 'nostr-tools/nip04';

// Read configuration from meta tags
function getRecipientPublicKey() {
    const meta = document.querySelector('meta[name="nostr:recipient"]');
    if (!meta) {
        throw new Error('Recipient public key not found in meta tags');
    }
    return meta.getAttribute('content');
}

function getRelays() {
    const meta = document.querySelector('meta[name="nostr:relays"]');
    if (meta) {
        try {
            return JSON.parse(meta.getAttribute('content'));
        } catch (e) {
            console.error('Failed to parse relays from meta tag, using defaults', e);
        }
    }
    // Default relays
    return [
        'wss://nos.lol',
        'wss://nostr.bitcoiner.social',
        'wss://relay.nostr.band',
        'wss://relay.damus.io',
        'wss://nostr.einundzwanzig.space',
        'wss://relay.nostrplebs.com'
    ];
}

function getPowDifficulty() {
    const meta = document.querySelector('meta[name="nostr:pow"]');
    if (meta) {
        const difficulty = parseInt(meta.getAttribute('content'), 10);
        if (!isNaN(difficulty) && difficulty >= 0) {
            return difficulty;
        }
    }
    return 0; // Default: no PoW required
}

function isContactOptional() {
    const meta = document.querySelector('meta[name="nostr:contact-optional"]');
    if (meta) {
        const value = meta.getAttribute('content').toLowerCase();
        return value === 'true';
    }
    return false; // Default: contact is required
}

// Theme management
function getThemeSetting() {
    const meta = document.querySelector('meta[name="nostr:theme"]');
    if (meta) {
        const value = meta.getAttribute('content').toLowerCase();
        if (['light', 'dark', 'auto'].includes(value)) {
            return value;
        }
    }
    return 'auto'; // Default: auto
}

function getSystemTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

function getCurrentAppliedTheme() {
    return document.body.hasAttribute('data-theme') ? 'dark' : 'light';
}

function applyTheme(themeSetting) {
    let actualTheme = themeSetting;
    if (themeSetting === 'auto') {
        actualTheme = getSystemTheme();
    }

    if (actualTheme === 'dark') {
        document.body.setAttribute('data-theme', 'dark');
        document.getElementById('themeIcon').textContent = '☀';
    } else {
        document.body.removeAttribute('data-theme');
        document.getElementById('themeIcon').textContent = '☾';
    }

    // Save the setting (not the resolved theme)
    localStorage.setItem('nostr-form-theme', themeSetting);
}

function toggleTheme() {
    const currentSetting = localStorage.getItem('nostr-form-theme') || getThemeSetting();
    const currentApplied = getCurrentAppliedTheme();
    let newSetting;

    // Always flip from what's currently shown
    if (currentSetting === 'auto') {
        // If auto, flip to the opposite of what's currently displayed
        newSetting = currentApplied === 'dark' ? 'light' : 'dark';
    } else if (currentSetting === 'light') {
        newSetting = 'dark';
    } else {
        newSetting = 'light';
    }

    applyTheme(newSetting);
}

// Validate sender contact information
function validateSenderContact(contact) {
    if (!contact || contact.trim() === '') {
        return true; // Validation passes if empty - will check required status separately
    }

    contact = contact.trim();

    // Check if it's a valid email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(contact)) {
        return true;
    }

    // Check if it starts with npub or nprofile
    if (contact.startsWith('npub') || contact.startsWith('nprofile')) {
        return true;
    }

    // Check if it starts with https://
    if (contact.startsWith('https://')) {
        return true;
    }

    return false;
}

// NIP-13: Count leading zero bits in a hex string
function countLeadingZeroBits(hex) {
    let count = 0;
    for (let i = 0; i < hex.length; i++) {
        const nibble = parseInt(hex[i], 16);
        if (nibble === 0) {
            count += 4;
        } else {
            count += Math.clz32(nibble) - 28;
            break;
        }
    }
    return count;
}

// NIP-13: Mine proof of work for an event
async function mineEvent(event, targetDifficulty, onProgress) {
    if (targetDifficulty === 0) {
        return event; // No mining needed
    }

    let nonce = 0;
    let bestDifficulty = 0;
    const startTime = Date.now();

    while (true) {
        // Update nonce tag
        event.tags = event.tags.filter(tag => tag[0] !== 'nonce');
        event.tags.push(['nonce', nonce.toString(), targetDifficulty.toString()]);

        // Update created_at periodically to keep it fresh
        if (nonce % 1000 === 0) {
            event.created_at = Math.floor(Date.now() / 1000);
        }

        // Calculate event ID
        event.id = getEventHash(event);

        // Count leading zero bits
        const difficulty = countLeadingZeroBits(event.id);

        // Track best difficulty for progress reporting
        if (difficulty > bestDifficulty) {
            bestDifficulty = difficulty;
            if (onProgress) {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                onProgress(bestDifficulty, targetDifficulty, nonce, elapsed);
            }
        }

        // Check if we met the target
        if (difficulty >= targetDifficulty) {
            console.log(`Found PoW! Nonce: ${nonce}, Difficulty: ${difficulty}, Attempts: ${nonce + 1}`);
            return event;
        }

        nonce++;

        // Yield to browser every 10000 iterations to prevent UI freeze
        if (nonce % 10000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
}

function generateKeyPair() {
    const secretKey = generateSecretKey();
    const publicKey = getPublicKey(secretKey);
    return { pub: publicKey, priv: secretKey };
}

const keyPair = generateKeyPair();
let pool;
let relays;
let RECIPIENT_PUBLIC_KEY;

document.addEventListener('DOMContentLoaded', () => {
    try {
        // Initialize theme
        const savedTheme = localStorage.getItem('nostr-form-theme') || getThemeSetting();
        applyTheme(savedTheme);

        // Listen for system theme changes
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                const currentSetting = localStorage.getItem('nostr-form-theme') || getThemeSetting();
                if (currentSetting === 'auto') {
                    applyTheme('auto');
                }
            });
        }

        RECIPIENT_PUBLIC_KEY = getRecipientPublicKey();
        relays = getRelays();
        pool = new SimplePool();
        console.log('Generated KeyPair:', keyPair);
        console.log('Recipient:', RECIPIENT_PUBLIC_KEY);
        console.log('Relays:', relays);
    } catch (error) {
        console.error('Initialization error:', error);
        document.getElementById('responseArea').innerHTML = `Error: ${error.message}`;
        document.getElementById('sendButton').disabled = true;
    }
});

// Make toggleTheme available globally
window.toggleTheme = toggleTheme;

async function sendMessage(content, senderContact) {
    if (!content || content.trim() === '') {
        alert('Please enter a message');
        return;
    }

    // Check if contact is required
    const contactOptional = isContactOptional();
    if (!contactOptional && (!senderContact || senderContact.trim() === '')) {
        alert('Please provide your contact information');
        return;
    }

    // Validate sender contact if provided
    if (senderContact && !validateSenderContact(senderContact)) {
        alert('Invalid sender contact. Please provide a valid email address, Nostr identity (npub/nprofile), or SimpleX contact (https://)');
        return;
    }

    // Prepare the message with sender contact if provided
    let messageContent = content;
    if (senderContact && senderContact.trim() !== '') {
        messageContent = `Contact: ${senderContact.trim()}\n\n${content}`;
    }

    // Encrypt the content with the recipient's public key
    const encryptedContent = await encrypt(keyPair.priv, RECIPIENT_PUBLIC_KEY, messageContent);

    console.log(keyPair.pub)
    let event = {
        pubkey: keyPair.pub,
        created_at: Math.floor(Date.now() / 1000),
        kind: 4, // Kind 4 is a direct message
        tags: [['p', RECIPIENT_PUBLIC_KEY]], // 'p' tag for direct messages
        content: encryptedContent
    };

    // Disable form while processing
    document.getElementById('messageInput').disabled = true;
    document.getElementById('senderContact').disabled = true;
    const sendButton = document.getElementById('sendButton');
    sendButton.disabled = true;
    sendButton.style.backgroundColor = 'grey';
    const responseArea = document.getElementById('responseArea');

    // Get PoW difficulty and mine if needed
    const powDifficulty = getPowDifficulty();
    if (powDifficulty > 0) {
        sendButton.innerText = 'Please wait, I am working, message not sent yet...';
        responseArea.innerHTML = `To fight spam, I need to do some calculations. This might take a while. Difficulty: ${powDifficulty})...`;

        try {
            event = await mineEvent(event, powDifficulty, (current, target, nonce, elapsed) => {
                responseArea.innerHTML = `Mining... Best: ${current}/${target} bits (${nonce.toLocaleString()} attempts, ${elapsed}s)`;
            });
            responseArea.innerHTML = `Proof of work complete! Sending...`;
        } catch (error) {
            console.error('Mining error:', error);
            responseArea.innerHTML = "Mining failed. Please try again.";
            document.getElementById('messageInput').disabled = false;
            document.getElementById('senderContact').disabled = false;
            sendButton.disabled = false;
            sendButton.style.backgroundColor = '#2aa198';
            sendButton.innerText = 'Send Message';
            return;
        }
    }

    sendButton.innerText = 'Sending via Nostr...';

    // Finalize and sign the event
    const signedEvent = finalizeEvent(event, keyPair.priv);

    // Validate the event
    if (!validateEvent(signedEvent)) {
        console.error('Invalid event');
        responseArea.innerHTML = "Invalid event. Please try again.";
        document.getElementById('messageInput').disabled = false;
        document.getElementById('senderContact').disabled = false;
        sendButton.disabled = false;
        sendButton.style.backgroundColor = '#2aa198';
        sendButton.innerText = 'Send Message';
        return;
    }

    // Publish the event
    try {
        await Promise.any(pool.publish(relays, signedEvent));
        console.log('Published to at least one relay!');
        responseArea.innerHTML = "Message sent successfully! ✓";
    } catch (error) {
        console.error('Failed to publish:', error);
        responseArea.innerHTML = "Failed to send message. Please try again.";
        // Re-enable the form on failure
        document.getElementById('messageInput').disabled = false;
        document.getElementById('senderContact').disabled = false;
        sendButton.disabled = false;
        sendButton.style.backgroundColor = '#2aa198';
        sendButton.innerText = 'Send Message';
    }
}

window.sendMessage = sendMessage;
