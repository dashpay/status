import { useState, useEffect, useCallback, useRef } from 'react';

export function useNodeData() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const eventSourceRef = useRef(null);

  // Initial fetch
  useEffect(() => {
    fetch('/api/nodes')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setNodes(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch nodes:', err);
        setLoading(false);
      });
  }, []);

  // SSE for real-time updates
  useEffect(() => {
    const es = new EventSource('/api/events');
    eventSourceRef.current = es;

    es.addEventListener('nodeUpdate', (event) => {
      try {
        const updated = JSON.parse(event.data);
        setNodes((prev) => {
          const idx = prev.findIndex((n) => n.name === updated.name);
          if (idx === -1) return [...prev, updated];
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      } catch (err) {
        console.warn('Failed to parse SSE message:', err);
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects
      console.warn('SSE connection lost, reconnecting...');
    };

    return () => {
      es.close();
    };
  }, []);

  const refresh = useCallback(() => {
    fetch('/api/nodes')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setNodes)
      .catch(console.error);
  }, []);

  return { nodes, loading, refresh };
}
