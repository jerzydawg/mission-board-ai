/**
 * Mission Board Live Updates - Client-Side SSE Handler
 * Real-time event stream with toast notifications and UI updates
 * 
 * Improvements over Paperclip:
 * - Offline event queue (reconnects with lastEventId)
 * - Toast cooldown (max 3 toasts per 10s)
 * - Event filtering
 * - Desktop notifications (optional)
 * - Sound alerts for critical events
 */

(function() {
  'use strict';

  // Event source connection
  let eventSource = null;
  let lastEventId = 0;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;

  // Toast cooldown tracker
  const toastHistory = [];
  const TOAST_COOLDOWN_MS = 10000; // 10 seconds
  const MAX_TOASTS_PER_COOLDOWN = 3;

  // Connection state
  let connectionState = 'disconnected'; // disconnected|connecting|connected
  let offlineQueue = [];

  // Configuration
  const config = {
    enableDesktopNotifications: false, // Request permission on first event
    enableSoundAlerts: true,
    filters: {
      agent: null, // Filter by specific agent
      priority: null, // Filter by P0/P1/P2
      type: null, // Filter by event type
    },
  };

  /**
   * Initialize live updates
   */
  function init(options = {}) {
    // Apply config
    Object.assign(config, options);

    // Connect to SSE endpoint
    connect();

    // Update UI connection status
    updateConnectionStatus('connecting');

    // Handle visibility change (reconnect when tab becomes visible)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && connectionState === 'disconnected') {
        connect();
      }
    });

    console.log('[LiveUpdates] Initialized');
  }

  /**
   * Connect to SSE endpoint
   */
  function connect() {
    if (eventSource) {
      eventSource.close();
    }

    // Build URL with filters
    const params = new URLSearchParams();
    if (lastEventId > 0) params.append('lastEventId', lastEventId);
    if (config.filters.agent) params.append('agent', config.filters.agent);
    if (config.filters.priority) params.append('priority', config.filters.priority);
    if (config.filters.type) params.append('type', config.filters.type);

    const url = `/ops/mission-board/api/events?${params.toString()}`;

    // Create EventSource
    eventSource = new EventSource(url);
    connectionState = 'connecting';

    // Connection opened
    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      console.log('[LiveUpdates] Connected:', data.connectionId);
      
      connectionState = 'connected';
      reconnectAttempts = 0;
      updateConnectionStatus('connected');

      // Show reconnect notification (but not on first connect)
      if (lastEventId > 0) {
        showToast({
          title: 'Reconnected',
          body: 'Live updates resumed',
          tone: 'success',
          ttlMs: 2000,
        });
      }

      // Process offline queue
      processOfflineQueue();
    });

    // Heartbeat (connection health check)
    eventSource.addEventListener('heartbeat', (e) => {
      // Silent - just keeps connection alive
    });

    // Task assigned
    eventSource.addEventListener('task_assigned', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('task:created', data);
      
      showToast({
        title: 'New Task',
        body: ((data.task||data).agentId||'agent') + ': ' + ((data.task||data).title||'task').slice(0,50),
        tone: 'info',
      });

      invalidateQueries(['tasks', 'agents']);
    });

    // Task completed
    eventSource.addEventListener('task_completed', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('task:completed', data);
      
      const durationMin = Math.round(data.duration / 60000);
      
      showToast({
        title: 'Task Done',
        body: '✓ ' + ((data.task||data).title||'Task completed').slice(0,55),
        tone: 'success',
      });

      // Play success sound
      if (config.enableSoundAlerts) {
        playSound('success');
      }

      invalidateQueries(['tasks', 'agents']);
    });

    // Task failed
    eventSource.addEventListener('task_failed', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('task_failed', data);
      
      showToast({
        title: `${data.actor} task failed`,
        body: data.error || 'Unknown error',
        tone: 'error',
        ttlMs: 10000, // Longer for errors
        action: {
          label: 'View',
          href: `/ops/mission-board?task=${data.taskId}`,
        },
      });

      // Play error sound + desktop notification for critical failures
      if (config.enableSoundAlerts) {
        playSound('error');
      }
      
      if (data.priority === 'P0') {
        showDesktopNotification({
          title: '🚨 Critical Task Failed',
          body: `${data.title}: ${data.error}`,
          tag: `task_failed_${data.taskId}`,
        });
      }

      invalidateQueries(['tasks', 'agents']);
    });

    // Task progress
    eventSource.addEventListener('task_progress', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);

      handleEvent('task_progress', data);

      const p = data.progress || {};
      const tone = p.status === 'blocked' ? 'error' : p.status === 'waiting_on_model' ? 'warn' : 'info';
      showToast({
        title: `${data.actor} update`,
        body: p.message || p.nextStep || p.status || 'Progress update',
        tone,
        ttlMs: p.status === 'blocked' ? 8000 : 3500,
      });

      invalidateQueries(['tasks', 'agents']);
    });

    // Priority changed
    eventSource.addEventListener('task_priority_changed', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('task_priority_changed', data);
      
      showToast({
        title: 'Priority changed',
        body: `${data.title}: ${data.oldPriority} → ${data.newPriority}`,
        tone: data.newPriority === 'P0' ? 'warn' : 'info',
      });

      invalidateQueries(['tasks']);
    });

    // Agent run started
    eventSource.addEventListener('agent_run_started', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('agent_run_started', data);
      
      // Silent - just update UI
      invalidateQueries(['agents', 'runs']);
    });

    // Agent run completed
    eventSource.addEventListener('agent_run_completed', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('agent_run_completed', data);
      
      // Silent - already got task_completed
      invalidateQueries(['agents', 'runs']);
    });

    // Agent run failed
    eventSource.addEventListener('agent_run_failed', (e) => {
      const data = JSON.parse(e.data);
      lastEventId = parseInt(e.lastEventId, 10);
      
      handleEvent('agent_run_failed', data);
      
      // Silent - already got task_failed
      invalidateQueries(['agents', 'runs']);
    });

    // Connection error
    eventSource.onerror = () => {
      console.error('[LiveUpdates] Connection error');
      
      connectionState = 'disconnected';
      updateConnectionStatus('disconnected');
      
      eventSource.close();
      
      // Reconnect with exponential backoff
      reconnectAttempts++;
      
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        console.log(`[LiveUpdates] Reconnecting in ${delay}ms...`);
        
        setTimeout(connect, delay);
      } else {
        console.error('[LiveUpdates] Max reconnect attempts reached');
        showToast({
          title: 'Connection lost',
          body: 'Refresh page to reconnect',
          tone: 'error',
          ttlMs: 0, // Persistent
        });
      }
    };
  }

  /**
   * Show toast notification
   */
  function showToast(options) {
    // Check toast cooldown
    const now = Date.now();
    const recentToasts = toastHistory.filter(
      (t) => now - t < TOAST_COOLDOWN_MS
    );

    if (recentToasts.length >= MAX_TOASTS_PER_COOLDOWN) {
      console.log('[LiveUpdates] Toast cooldown active, skipping');
      return;
    }

    // Add to history
    toastHistory.push(now);

    // Use global toast function if available
    if (window.MissionBoard && window.MissionBoard.toast) {
      window.MissionBoard.toast(options);
    } else {
      // Fallback: console log
      console.log('[Toast]', options.title, options.body);
    }
  }

  /**
   * Show desktop notification
   */
  function showDesktopNotification(options) {
    if (!config.enableDesktopNotifications) {
      // Request permission on first use
      if (Notification.permission === 'default') {
        Notification.requestPermission().then((permission) => {
          if (permission === 'granted') {
            config.enableDesktopNotifications = true;
            showDesktopNotification(options);
          }
        });
      }
      return;
    }

    if (Notification.permission === 'granted') {
      new Notification(options.title, {
        body: options.body,
        tag: options.tag,
        icon: '/favicon.ico',
      });
    }
  }

  /**
   * Play sound alert
   */
  function playSound(type) {
    // Create audio context (lazy)
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // Sound profiles
    if (type === 'success') {
      oscillator.frequency.value = 800;
      gainNode.gain.value = 0.1;
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.1);
    } else if (type === 'error') {
      oscillator.frequency.value = 400;
      gainNode.gain.value = 0.15;
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.2);
    }
  }

  /**
   * Invalidate cached queries (triggers UI refresh)
   */
  function invalidateQueries(queries) {
    // Dispatch custom event for UI to listen
    window.dispatchEvent(
      new CustomEvent('mission-board:invalidate', {
        detail: { queries },
      })
    );
  }

  /**
   * Update connection status indicator
   */
  function updateConnectionStatus(status) {
    const indicator = document.getElementById('live-status-indicator');
    if (!indicator) return;

    if (status === 'connected') {
      if (indicator) { indicator.textContent = '🟢 Live'; indicator.className = 'live-status connected'; }
      window.dispatchEvent(new CustomEvent('mission-board:connected'));
    } else if (status === 'connecting') {
      if (indicator) { indicator.textContent = '🟡 Connecting...'; indicator.className = 'live-status connecting'; }
    } else {
      if (indicator) { indicator.textContent = '🔴 Offline'; indicator.className = 'live-status disconnected'; }
      window.dispatchEvent(new CustomEvent('mission-board:disconnected'));
    }
  }

  /**
   * Handle event (custom processing)
   */
  function handleEvent(type, data) {
    // Store in offline queue if disconnected
    if (connectionState === 'disconnected') {
      offlineQueue.push({ type, data, timestamp: Date.now() });
    }

    // Dispatch custom event for advanced integrations
    window.dispatchEvent(
      new CustomEvent('mission-board:event', {
        detail: { type, data },
      })
    );
  }

  /**
   * Process offline event queue
   */
  function processOfflineQueue() {
    if (offlineQueue.length === 0) return;

    console.log(`[LiveUpdates] Processing ${offlineQueue.length} offline events`);

    // Show summary toast
    showToast({
      title: 'Caught up',
      body: `Processed ${offlineQueue.length} events while offline`,
      tone: 'info',
      ttlMs: 3000,
    });

    // Clear queue
    offlineQueue = [];

    // Invalidate all queries
    invalidateQueries(['tasks', 'agents', 'runs']);
  }

  /**
   * Update filters
   */
  function setFilters(filters) {
    Object.assign(config.filters, filters);
    
    // Reconnect with new filters
    connect();
  }

  /**
   * Disconnect
   */
  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    
    connectionState = 'disconnected';
    updateConnectionStatus('disconnected');
  }

  // Expose public API
  window.MissionBoardLiveUpdates = {
    init,
    setFilters,
    disconnect,
    getState: () => ({
      connectionState,
      lastEventId,
      reconnectAttempts,
      offlineQueueSize: offlineQueue.length,
    }),
  };

  console.log('[LiveUpdates] Module loaded');
})();
