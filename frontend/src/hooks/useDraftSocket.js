/**
 * src/hooks/useDraftSocket.js
 * Manages the Socket.io connection to the draft room.
 *
 * Usage:
 *   const { state, error, connected, placeBid, nominate, pass } = useDraftSocket(sessionId);
 *
 * The hook:
 *   - Connects on mount, disconnects on unmount
 *   - Authenticates with the stored auth token immediately on connect
 *   - Keeps local `state` in sync with server broadcasts
 *   - Exposes typed action functions that emit Socket.io events
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { auth } from '../lib/api';

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3001';

export function useDraftSocket(sessionId) {
  const socketRef = useRef(null);
  const [connected, setConnected]     = useState(false);
  const [draftState, setDraftState]   = useState(null);
  const [error, setError]             = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [chatMessages, setChatMessages] = useState([]);

  useEffect(() => {
    if (!sessionId) return;

    const token = auth.getToken();
    if (!token) { setError('No auth token. Please join a league first.'); return; }

    const socket = io(WS_URL, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    // ── Connection lifecycle ──────────────────────────────────────────────

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
      // Authenticate immediately
      socket.emit('draft:join', { token });
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('connect_error', (err) => {
      setError(`Connection failed: ${err.message}`);
    });

    // ── Draft events ──────────────────────────────────────────────────────

    socket.on('draft:state', (state) => {
      setDraftState(state);
      setSecondsLeft(state.secondsLeft ?? 30);
    });

    socket.on('draft:timer', ({ secondsLeft }) => {
      setSecondsLeft(secondsLeft);
    });

    socket.on('draft:sold', ({ movie, winner, amount }) => {
      // Optimistic UI: brief flash, then state update will arrive
      setDraftState(prev => prev ? {
        ...prev,
        _lastSale: { movie, winner, amount, at: Date.now() },
      } : prev);
    });

    socket.on('draft:complete', ({ standings }) => {
      setDraftState(prev => prev ? { ...prev, phase: 'complete', _finalStandings: standings } : prev);
    });

    socket.on('draft:error', ({ message }) => {
      setError(message);
      // Auto-clear after 8s
      setTimeout(() => setError(null), 8000);
    });

    socket.on('queue:updated', ({ queue }) => {
      setDraftState(prev => prev ? { ...prev, queue } : prev);
    });

    socket.on('scores:updated', () => {
      // Trigger a re-fetch of league data from parent
    });

    // ── Chat events ───────────────────────────────────────────────────────

    socket.on('chat:history', (messages) => {
      setChatMessages(messages);
    });

    socket.on('chat:message', (msg) => {
      setChatMessages(prev => [...prev, msg]);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId]);

  // ── Action emitters ───────────────────────────────────────────────────────

  const startDraft = useCallback(() => {
    socketRef.current?.emit('draft:start', { sessionId });
  }, [sessionId]);

  const placeBid = useCallback((amount) => {
    setError(null);
    socketRef.current?.emit('draft:bid', { amount });
  }, []);

  const nominate = useCallback((movieId) => {
    socketRef.current?.emit('draft:nominate', { movieId });
  }, []);

  const pass = useCallback(() => {
    socketRef.current?.emit('draft:pass');
  }, []);

  const sendChatMessage = useCallback((message) => {
    socketRef.current?.emit('chat:send', { message });
  }, []);

  const shuffleNominationOrder = useCallback(() => {
    socketRef.current?.emit('draft:shuffle', {});
  }, []);

  return {
    connected,
    draftState,
    secondsLeft,
    chatMessages,
    error,
    clearError: () => setError(null),
    actions: { startDraft, placeBid, nominate, pass, sendChatMessage, shuffleNominationOrder },
  };
}
