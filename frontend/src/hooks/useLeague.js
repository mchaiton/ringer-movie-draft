/**
 * src/hooks/useLeague.js
 * Fetches league data for the authenticated player.
 * Polls the scoring feed every 30s during active season.
 */

import { useState, useEffect, useCallback } from 'react';
import { leagueApi, auth } from '../lib/api';

export function useLeague() {
  const player  = auth.getPlayer();
  const league  = auth.getLeague();
  const leagueId = league?.id;

  const [data, setData]       = useState(null);
  const [feed, setFeed]       = useState([]);
  const [pool, setPool]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fetchLeague = useCallback(async () => {
    if (!leagueId) return;
    try {
      const res = await leagueApi.get(leagueId);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [leagueId]);

  const fetchFeed = useCallback(async () => {
    if (!leagueId) return;
    try {
      const res = await leagueApi.feed(leagueId);
      setFeed(res.feed || []);
    } catch {}
  }, [leagueId]);

  const fetchPool = useCallback(async (filters = {}) => {
    if (!leagueId) return;
    try {
      const res = await leagueApi.pool(leagueId, filters);
      setPool(res.movies || []);
    } catch {}
  }, [leagueId]);

  useEffect(() => {
    fetchLeague();
    fetchFeed();
    fetchPool();
  }, [fetchLeague, fetchFeed, fetchPool]);

  // Poll feed every 30s
  useEffect(() => {
    const interval = setInterval(fetchFeed, 30_000);
    return () => clearInterval(interval);
  }, [fetchFeed]);

  return {
    league: data?.league,
    you: data?.you,
    standings: data?.standings || [],
    nominationQueue: data?.nominationQueue || [],
    feed,
    pool,
    loading,
    error,
    refetch: fetchLeague,
    refetchPool: fetchPool,
  };
}
