/**
 * Mission Board Toast Notification System
 * Stolen from Paperclip, improved by Mr. Web
 * 
 * Features:
 * - 4 tones: info, success, warn, error
 * - Auto-dismiss based on severity
 * - Deduplication (no duplicates within 3.5s)
 * - Max 5 concurrent toasts
 * - Action buttons
 * - Desktop notifications (IMPROVEMENT)
 * - Sound alerts for critical (IMPROVEMENT)
 */

(function() {
  'use strict';

  // Ensure MissionBoard namespace exists
  window.MissionBoard = window.MissionBoard || {};

  // Toast configuration
  const CONFIG = {
    MAX_TOASTS: 5,
    DEDUP_WINDOW_MS: 3500,
    DEFAULT_TTL: {
      info: 4000,
      success: 3500,
      warn: 8000,
      error: 10000
    },
    SOUNDS: {
      error: '/sounds/error.mp3',
      warn: '/sounds/warn.mp3'
    }
  };

  // Toast state
  let toasts = [];
  let toastHistory = []; // For deduplication
  let container = null;
  let audioContext = null;
  let soundBuffers = {};

  /**
   * Initialize toast system
   */
  function init() {
    // Create container
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Preload sounds
    if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
      audioContext = new (AudioContext || webkitAudioContext)();
      preloadSounds();
    }
  }

  /**
   * Preload sound effects
   */
  function preloadSounds() {
    Object.entries(CONFIG.SOUNDS).forEach(([tone, url]) => {
      fetch(url)
        .then(res => res.arrayBuffer())
        .then(buffer => audioContext.decodeAudioData(buffer))
        .then(decoded => {
          soundBuffers[tone] = decoded;
        })
        .catch(() => {
          // Silently fail if sounds don't exist yet
        });
    });
  }

  /**
   * Play sound for toast tone
   */
  function playSound(tone) {
    if (!audioContext || !soundBuffers[tone]) return;
    
    const source = audioContext.createBufferSource();
    source.buffer = soundBuffers[tone];
    source.connect(audioContext.destination);
    source.start(0);
  }

  /**
   * Show desktop notification
   */
  function showDesktopNotification(options) {
    if ('Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(options.title, {
        body: options.body,
        icon: '/images/logo-icon.png',
        badge: '/images/logo-icon.png',
        tag: options.id // Prevents duplicates
      });

      if (options.action) {
        notification.onclick = () => {
          window.focus();
          window.location.href = options.action.href;
          notification.close();
        };
      }
    }
  }

  /**
   * Generate toast ID
   */
  function generateId() {
    return `toast_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if toast is duplicate
   */
  function isDuplicate(title, body) {
    const now = Date.now();
    const key = `${title}|${body}`;
    
    // Clean old history
    toastHistory = toastHistory.filter(h => now - h.timestamp < CONFIG.DEDUP_WINDOW_MS);
    
    // Check for duplicate
    if (toastHistory.some(h => h.key === key)) {
      return true;
    }
    
    // Add to history
    toastHistory.push({ key, timestamp: now });
    return false;
  }

  /**
   * Create toast element
   */
  function createToastElement(options) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${options.tone}`;
    toast.dataset.id = options.id;

    // Icon based on tone
    const icons = {
      info: '&#9432;', // ℹ
      success: '&#10003;', // ✓
      warn: '&#9888;', // ⚠
      error: '&#10005;' // ✕
    };

    let html = `
      <div class="toast-icon">${icons[options.tone]}</div>
      <div class="toast-content">
        <div class="toast-title">${escapeHtml(options.title)}</div>
        <div class="toast-body">${escapeHtml(options.body)}</div>
      </div>
    `;

    if (options.action) {
      html += `
        <a href="${escapeHtml(options.action.href)}" class="toast-action">
          ${escapeHtml(options.action.label)}
        </a>
      `;
    }

    html += `<button class="toast-close" aria-label="Close">&times;</button>`;
    
    toast.innerHTML = html;

    // Close button handler
    toast.querySelector('.toast-close').addEventListener('click', () => {
      removeToast(options.id);
    });

    return toast;
  }

  /**
   * Remove toast
   */
  function removeToast(id) {
    const index = toasts.findIndex(t => t.id === id);
    if (index === -1) return;

    const toast = toasts[index];
    
    // Clear timeout
    if (toast.timeout) {
      clearTimeout(toast.timeout);
    }

    // Remove from DOM
    if (toast.element && toast.element.parentNode) {
      toast.element.classList.add('toast-removing');
      setTimeout(() => {
        if (toast.element && toast.element.parentNode) {
          toast.element.parentNode.removeChild(toast.element);
        }
      }, 300); // Match CSS animation duration
    }

    // Remove from state
    toasts.splice(index, 1);
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Main toast function
   */
  function toast(options) {
    // Validate options
    if (!options || !options.title || !options.body) {
      console.error('Toast requires title and body');
      return;
    }

    // Default tone
    options.tone = options.tone || 'info';
    if (!['info', 'success', 'warn', 'error'].includes(options.tone)) {
      console.error(`Invalid tone: ${options.tone}`);
      return;
    }

    // Check for duplicate
    if (isDuplicate(options.title, options.body)) {
      return;
    }

    // Generate ID
    options.id = generateId();

    // Default TTL
    if (!options.ttlMs) {
      options.ttlMs = CONFIG.DEFAULT_TTL[options.tone];
    }

    // Limit to 1.5s - 15s
    options.ttlMs = Math.max(1500, Math.min(15000, options.ttlMs));

    // Remove oldest toast if at max
    if (toasts.length >= CONFIG.MAX_TOASTS) {
      removeToast(toasts[0].id);
    }

    // Create toast element
    const element = createToastElement(options);
    container.appendChild(element);

    // Add to state
    const toastObj = {
      id: options.id,
      element: element,
      timeout: setTimeout(() => {
        removeToast(options.id);
      }, options.ttlMs)
    };
    toasts.push(toastObj);

    // Play sound for warn/error
    if (options.tone === 'warn' || options.tone === 'error') {
      playSound(options.tone);
    }

    // Show desktop notification for error
    if (options.tone === 'error') {
      showDesktopNotification(options);
    }

    // Trigger animation
    setTimeout(() => {
      element.classList.add('toast-show');
    }, 10);
  }

  /**
   * Clear all toasts
   */
  function clearAll() {
    toasts.forEach(t => removeToast(t.id));
  }

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose API
  window.MissionBoard.toast = toast;
  window.MissionBoard.toast.clearAll = clearAll;

})();
